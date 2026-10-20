import { Effect } from "effect"
import { fingerprint } from "./baseline.ts"
import type { Finding, Verdict } from "./lint.ts"
import type { Policy } from "./policy.ts"

const levels: Readonly<Record<Exclude<Verdict, "pass">, "error" | "warning" | "note">> = {
  violation: "error",
  review: "warning",
  inconclusive: "note"
}

/** The policy's first Markdown heading, or its name. */
const titleOf = (policy: Policy) =>
  /^#\s+(.+)$/m.exec(policy.source.replace(/^---\r?\n.*?\r?\n---(?:\r?\n|$)/s, ""))?.[1]?.trim() ?? policy.name

/**
 * A SARIF 2.1.0 log of the run: one rule per policy, and one result per non-passing finding — `error` for
 * a violation, `warning` for review, `note` for inconclusive. Findings the baseline accepts are included as
 * suppressed. A result's location is its file (and lines, for items that have them); findings without a
 * path have no location. `partialFingerprints` carry the item's text fingerprint (or policy and path for a
 * whole-file finding), so code scanning can follow a finding as code moves.
 */
export const toSarif = (findings: ReadonlyArray<Finding>, policies: ReadonlyArray<Policy>, version: string) => ({
  $schema: "https://json.schemastore.org/sarif-2.1.0.json",
  version: "2.1.0",
  runs: [{
    tool: {
      driver: {
        name: "lint-anything",
        version,
        rules: policies.map((policy) => ({
          id: policy.name,
          name: policy.name,
          shortDescription: { text: titleOf(policy) },
          fullDescription: { text: policy.source.replace(/^---\r?\n.*?\r?\n---(?:\r?\n|$)/s, "").trim() }
        }))
      }
    },
    results: findings.flatMap((finding) => {
      if (finding.verdict === "pass") return []
      const ruleIndex = policies.findIndex((policy) => policy.name === finding.policy)
      const message = finding.violates === undefined
        ? `${finding.verdict}: ${finding.reason ?? finding.policy}`
        : `${finding.verdict} (violation probability ${finding.violates.toFixed(2)})${finding.item === undefined ? "" : `: ${finding.item}`}`
      return [{
        ruleId: finding.policy,
        ...(ruleIndex === -1 ? {} : { ruleIndex }),
        level: levels[finding.verdict],
        message: { text: message },
        ...(finding.path === undefined ? {} : {
          locations: [{
            physicalLocation: {
              artifactLocation: { uri: finding.path, uriBaseId: "%SRCROOT%" },
              ...(finding.lines === undefined ? {} : { region: { startLine: finding.lines[0], endLine: finding.lines[1] } })
            }
          }]
        }),
        partialFingerprints: { "lintAnything/v1": finding.fingerprint ?? fingerprint(`${finding.policy}\0${finding.path ?? ""}`) },
        ...(finding.accepted === true ? { suppressions: [{ kind: "external", justification: "accepted by the lint-anything baseline" }] } : {}),
        ...(finding.violates === undefined ? {} : { properties: { violates: finding.violates } })
      }]
    })
  }]
})

export const writeSarif = (file: string, log: ReturnType<typeof toSarif>) =>
  Effect.promise(() => Bun.write(file, `${JSON.stringify(log, null, 2)}\n`))

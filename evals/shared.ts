// Measures shared steps: policies that use the same evidence step and selector should run each once per lint
// run. Lints this repository's own TypeScript with six policies sharing both, against a stub Clef (no
// requests), and counts executions through a log each shared command appends to.
//   bun evals/shared.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Result } from "effect"
import { Clef } from "../src/clef.ts"
import { lint } from "../src/lint.ts"
import { parsePolicy } from "../src/policy.ts"
import { readSources } from "../src/source.ts"

const directory = mkdtempSync(join(tmpdir(), "lint-anything-shared-"))
const log = join(directory, "runs.log")
process.env.RUNS_LOG = log
const rules = ["Names describe intent.", "Comments explain why.", "Values that carry meaning are named.",
  "Errors keep their context.", "Functions do one thing.", "Exports are minimal."]
const policies = rules.map((rule, index) =>
  Effect.runSync(parsePolicy(`shared/${index}`, `---
globs: ["src/**/*.ts"]
evidence:
  files: echo evidence >> "$RUNS_LOG"; ls "$@" | wc -l
select: |
  echo select >> "$RUNS_LOG"
  rg --json -w 'const' "$@" |
    jq -c 'select(.type == "match") | {id: "\\(.data.path.text):\\(.data.line_number)", path: .data.path.text, lines: [.data.line_number, .data.line_number], text: (.data.lines.text | rtrimstr("\\n"))}' |
    $LINT_ANYTHING enclosing
---
# Rule ${index}

${rule} The repository has {{files}} files.
`)))

// Every judgment scores 0.1; this eval measures the steps, not Clef.
const stub = Layer.succeed(Clef, Clef.of({
  judge: (_, applicable) => Effect.succeed(applicable.map(() => Result.succeed({ violates: 0.1 }))),
  judgeItems: (_, items) => Effect.succeed(items.map(() => Result.succeed({ violates: 0.1 })))
}))

const started = performance.now()
const findings = await Effect.runPromise(
  readSources(["src/**/*.ts"]).pipe(
    Effect.flatMap((files) => lint(files, policies, { threshold: 0.45, itemThreshold: 0.65 })),
    Effect.provide(Layer.mergeAll(stub, BunServices.layer))
  )
)
const ms = performance.now() - started
const runs = readFileSync(log, "utf8").trim().split("\n")
rmSync(directory, { recursive: true, force: true })
const count = (kind: string) => runs.filter((run) => run === kind).length
const perPolicy = new Map<string, number>()
for (const finding of findings) perPolicy.set(finding.policy, (perPolicy.get(finding.policy) ?? 0) + 1)
console.log(`${policies.length} policies sharing one evidence step and one selector over src/**/*.ts:`)
console.log(`- evidence step ran ${count("evidence")} time(s), selector ${count("select")} time(s) (without sharing: ${policies.length} each)`)
console.log(`- ${findings.length} findings, ${[...new Set(perPolicy.values())].join("/")} per policy; ${Math.round(ms)} ms`)
const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify(findings.map((finding) => JSON.stringify(finding)).sort())).digest("hex")
console.log(`- findings digest ${digest.slice(0, 16)}`)

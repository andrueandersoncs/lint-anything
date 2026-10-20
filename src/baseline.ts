import { Effect, Runtime, Schema } from "effect"
import type { Finding } from "./lint.ts"

export class BaselineError extends Schema.TaggedError<BaselineError>()("BaselineError", {
  message: Schema.String
}) {
  override readonly [Runtime.errorExitCode] = 2
}

/** A short hash of an item's text with whitespace collapsed, so moving or re-indenting it keeps its identity. */
export const fingerprint = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16)

const Entry = Schema.Struct({
  policy: Schema.String,
  path: Schema.optional(Schema.String),
  fingerprint: Schema.optional(Schema.String)
})
const BaselineFile = Schema.Struct({ accepted: Schema.Array(Entry) })
type Entry = typeof Entry.Type

/**
 * What identifies a finding across runs: its policy, path, and (for items) text fingerprint, but not its
 * lines, which shift as code moves. A whole-file finding is identified by policy and path alone.
 */
const keyOf = (finding: Entry) => JSON.stringify([finding.policy, finding.path ?? null, finding.fingerprint ?? null])

const entryOf = ({ policy, path, fingerprint }: Finding): Entry => ({
  policy,
  ...(path === undefined ? {} : { path }),
  ...(fingerprint === undefined ? {} : { fingerprint })
})

/** Writes every non-passing finding to `file` as accepted. */
export const writeBaseline = (file: string, findings: ReadonlyArray<Finding>) =>
  Effect.promise(() =>
    Bun.write(file, `${JSON.stringify({ accepted: findings.filter((finding) => finding.verdict !== "pass").map(entryOf) }, null, 2)}\n`)
  )

/**
 * Marks findings the baseline in `file` accepts. Entries are matched as a multiset: two accepted copies
 * of an item accept two findings with that key, and a third is new. Returns the findings and how many
 * accepted entries matched nothing (fixed or gone).
 */
export const applyBaseline = Effect.fn("applyBaseline")(function*(file: string, findings: ReadonlyArray<Finding>) {
  const text = yield* Effect.tryPromise({
    try: () => Bun.file(file).text(),
    catch: () => new BaselineError({ message: `cannot read baseline ${file}` })
  })
  const { accepted } = yield* Effect.try(() => JSON.parse(text)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(BaselineFile)),
    Effect.mapError(() => new BaselineError({ message: `${file} is not a baseline written by --write-baseline` }))
  )
  const remaining = new Map<string, number>()
  for (const entry of accepted) remaining.set(keyOf(entry), (remaining.get(keyOf(entry)) ?? 0) + 1)
  const marked = findings.map((finding): Finding => {
    if (finding.verdict === "pass") return finding
    const key = keyOf(entryOf(finding))
    const left = remaining.get(key) ?? 0
    if (left === 0) return finding
    remaining.set(key, left - 1)
    return { ...finding, accepted: true }
  })
  return { findings: marked, stale: [...remaining.values()].reduce((sum, count) => sum + count, 0) }
})

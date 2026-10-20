import { Effect, FileSystem, Path, Runtime, Schema } from "effect"
import { type Item, toItem } from "./item.ts"

/**
 * A Markdown rule. Without `select` it is judged against each whole file its globs match. With
 * `select`, a shell command emits the items to judge: it receives the matching files as arguments, or
 * none when the policy has no globs. `evidence` steps run first, in order, with the same arguments; the
 * rule text can include their output as `{{name}}`. `examples` are labeled items (or, without a selector,
 * labeled files) that `lint-anything check` judges against the rule. With `limit`, a selector policy
 * reports how many of its items violate the rule, per file or per run, against a maximum. The full policy
 * text is sent to Clef.
 */
export interface Policy {
  readonly name: string
  readonly source: string
  readonly globs: ReadonlyArray<Bun.Glob>
  readonly select?: string
  readonly evidence: ReadonlyArray<{ readonly name: string; readonly command: string }>
  readonly examples: ReadonlyArray<{ readonly violates: boolean; readonly item: Item }>
  readonly limit?: { readonly max: number; readonly per: "file" | "run" }
}

export class PolicyError extends Schema.TaggedError<PolicyError>()("PolicyError", {
  message: Schema.String
}) {
  override readonly [Runtime.errorExitCode] = 2
}

const Frontmatter = Schema.Struct({
  globs: Schema.optional(Schema.NonEmptyArray(Schema.NonEmptyString)),
  select: Schema.optional(Schema.NonEmptyString),
  evidence: Schema.optional(Schema.Record(Schema.String, Schema.NonEmptyString)),
  examples: Schema.optional(Schema.Array(Schema.Unknown)),
  limit: Schema.optional(Schema.Struct({
    max: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    per: Schema.optional(Schema.Literals(["file", "run"]))
  }))
})

const frontmatterPattern = /^---\r?\n(.*?)\r?\n---(?:\r?\n|$)/s
const stepName = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `{{name}}` references in a rule body. */
export const referencePattern = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

export const parsePolicy = Effect.fn("parsePolicy")(function*(name: string, source: string) {
  const match = frontmatterPattern.exec(source)
  if (match === null) {
    return yield* new PolicyError({ message: `${name}: missing frontmatter` })
  }
  const body = source.slice(match[0].length)
  if (body.trim() === "") {
    return yield* new PolicyError({ message: `${name}: empty policy` })
  }
  const { globs, select, evidence, examples, limit } = yield* Effect.try(() => Bun.YAML.parse(match[1] ?? "")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Frontmatter)),
    Effect.mapError((error) => new PolicyError({ message: `${name}: invalid frontmatter: ${String(error.message ?? error)}` }))
  )
  if (globs === undefined && select === undefined) {
    return yield* new PolicyError({ message: `${name}: frontmatter needs non-empty globs, a select command, or both` })
  }
  if (limit !== undefined && select === undefined) {
    return yield* new PolicyError({ message: `${name}: limit counts a selector's items, so it needs select` })
  }
  const steps = Object.entries(evidence ?? {}).map(([step, command]) => ({ name: step, command }))
  const badName = steps.find((step) => !stepName.test(step.name))
  if (badName !== undefined) {
    return yield* new PolicyError({ message: `${name}: evidence step name ${badName.name} must match [A-Za-z_][A-Za-z0-9_]*` })
  }
  const unknown = [...body.matchAll(referencePattern)].map((reference) => reference[1]!).find((reference) => !steps.some((step) => step.name === reference))
  if (unknown !== undefined) {
    return yield* new PolicyError({ message: `${name}: the rule references {{${unknown}}}, which no evidence step defines` })
  }
  const labeled: Array<{ readonly violates: boolean; readonly item: Item }> = []
  for (const [index, example] of (examples ?? []).entries()) {
    const { violates, ...fields } = (typeof example === "object" && example !== null ? example : {}) as Record<string, unknown>
    if (typeof violates !== "boolean") {
      return yield* new PolicyError({ message: `${name}: example ${index + 1} needs violates: true or false` })
    }
    const item = yield* toItem({ id: `example ${index + 1}`, ...fields }).pipe(
      Effect.mapError((reason) => new PolicyError({ message: `${name}: example ${index + 1} is not a valid item: ${reason}` }))
    )
    labeled.push({ violates, item })
  }
  return {
    name,
    source,
    globs: (globs ?? []).map((glob) => new Bun.Glob(glob)),
    ...(select === undefined ? {} : { select }),
    evidence: steps,
    examples: labeled,
    ...(limit === undefined ? {} : { limit: { max: limit.max, per: limit.per ?? "file" } })
  } satisfies Policy
})

/**
 * The policy without its `examples` key, so the rule can be judged on examples it hasn't seen. The rest of
 * the frontmatter keeps its exact text.
 */
export const withoutExamples = (policy: Policy): Policy => {
  const match = frontmatterPattern.exec(policy.source)!
  const kept: Array<string> = []
  let inExamples = false
  for (const line of match[1]!.split(/\r?\n/)) {
    // A top-level key starts at column 0; the examples block runs until the next one.
    const key = /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1]
    if (key !== undefined) inExamples = key === "examples"
    if (!inExamples) kept.push(line)
  }
  return { ...policy, source: `---\n${kept.join("\n")}\n---\n${policy.source.slice(match[0].length)}`, examples: [] }
}

/** The policy with each `{{name}}` in its rule body replaced by that evidence step's output. */
export const resolveReferences = (policy: Policy, outputs: ReadonlyMap<string, string>): Policy => {
  const match = frontmatterPattern.exec(policy.source)!
  const body = policy.source.slice(match[0].length).replace(referencePattern, (_, step: string) => outputs.get(step) ?? "")
  return { ...policy, source: `${match[0]}${body}` }
}

export const matches = (policy: Policy, path: string): boolean => policy.globs.some((glob) => glob.match(path))

/** Loads every `*.md` policy under `directory`. A missing or empty directory is an error. */
export const loadPolicies = Effect.fn("loadPolicies")(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const unreadable = () => new PolicyError({ message: `cannot read policies in ${directory}` })
  const entries = yield* fs.readDirectory(directory, { recursive: true }).pipe(Effect.mapError(unreadable))
  const files = entries.filter((entry) => entry.endsWith(".md")).sort()
  if (files.length === 0) {
    return yield* new PolicyError({ message: `no policies in ${directory}` })
  }
  return yield* Effect.forEach(files, (file) =>
    fs.readFileString(path.join(directory, file)).pipe(
      Effect.mapError(unreadable),
      Effect.flatMap((source) => parsePolicy(file.slice(0, -".md".length), source))
    ))
})

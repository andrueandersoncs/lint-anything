import { Effect, FileSystem, Path, Runtime, Schema } from "effect"

/**
 * A Markdown rule. Without `select` it is judged against each whole file its globs match. With
 * `select`, a shell command emits the items to judge: it receives the matching files as arguments, or
 * none when the policy has no globs. The full policy text is sent to Clef.
 */
export interface Policy {
  readonly name: string
  readonly source: string
  readonly globs: ReadonlyArray<Bun.Glob>
  readonly select?: string
}

export class PolicyError extends Schema.TaggedError<PolicyError>()("PolicyError", {
  message: Schema.String
}) {
  override readonly [Runtime.errorExitCode] = 2
}

const Frontmatter = Schema.Struct({
  globs: Schema.optional(Schema.NonEmptyArray(Schema.NonEmptyString)),
  select: Schema.optional(Schema.NonEmptyString)
}).check(Schema.makeFilter(({ globs, select }) => globs !== undefined || select !== undefined))

const frontmatterPattern = /^---\r?\n(.*?)\r?\n---(?:\r?\n|$)/s

export const parsePolicy = Effect.fn("parsePolicy")(function*(name: string, source: string) {
  const match = frontmatterPattern.exec(source)
  if (match === null) {
    return yield* new PolicyError({ message: `${name}: missing frontmatter` })
  }
  if (source.slice(match[0].length).trim() === "") {
    return yield* new PolicyError({ message: `${name}: empty policy` })
  }
  const { globs, select } = yield* Effect.try(() => Bun.YAML.parse(match[1] ?? "")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Frontmatter)),
    Effect.mapError(() => new PolicyError({ message: `${name}: frontmatter needs non-empty globs, a select command, or both` }))
  )
  return {
    name,
    source,
    globs: (globs ?? []).map((glob) => new Bun.Glob(glob)),
    ...(select === undefined ? {} : { select })
  } satisfies Policy
})

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

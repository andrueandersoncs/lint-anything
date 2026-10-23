import { Effect, FileSystem, Path, Runtime, Schema } from "effect"

/**
 * A Markdown policy: everything Clef is asked. The body after the frontmatter is the request's text, sent
 * exactly as written (the rule, and any framing or examples the author wants). The `select` shell command
 * finds what to judge itself and emits it as items; each item's text is one question.
 * `criteria` optionally says what a yes and a no mean for every question. With `limit`, the policy reports
 * how many of its items violate the rule, per file or per run, against a maximum.
 */
export interface Policy {
  readonly name: string
  readonly body: string
  readonly select: string
  readonly criteria?: { readonly true?: string; readonly false?: string }
  readonly limit?: { readonly max: number; readonly per: "file" | "run" }
}

export class PolicyError extends Schema.TaggedError<PolicyError>()("PolicyError", {
  message: Schema.String
}) {
  override readonly [Runtime.errorExitCode] = 2
}

const Frontmatter = Schema.Struct({
  select: Schema.optional(Schema.NonEmptyString),
  criteria: Schema.optional(Schema.Struct({
    true: Schema.optional(Schema.NonEmptyString),
    false: Schema.optional(Schema.NonEmptyString)
  })),
  limit: Schema.optional(Schema.Struct({
    max: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    per: Schema.optional(Schema.Literals(["file", "run"]))
  }))
})

const frontmatterPattern = /^---\r?\n(.*?)\r?\n---(?:\r?\n|$)/s

export const parsePolicy = Effect.fn("parsePolicy")(function*(name: string, source: string) {
  const match = frontmatterPattern.exec(source)
  if (match === null) {
    return yield* new PolicyError({ message: `${name}: missing frontmatter` })
  }
  const body = source.slice(match[0].length)
  if (body.trim() === "") {
    return yield* new PolicyError({ message: `${name}: empty policy` })
  }
  const parsed = yield* Effect.try(() => Bun.YAML.parse(match[1] ?? "")).pipe(
    Effect.mapError((error) => new PolicyError({ message: `${name}: invalid frontmatter: ${String(error.message ?? error)}` }))
  )
  const unknown = Object.keys(typeof parsed === "object" && parsed !== null ? parsed : {}).filter((key) => !(key in Frontmatter.fields))
  if (unknown.length > 0) {
    return yield* new PolicyError({
      message: `${name}: unknown frontmatter ${unknown.join(", ")}; a policy has select, criteria, and limit, and its body is everything else Clef reads`
    })
  }
  const { select, criteria, limit } = yield* Schema.decodeUnknownEffect(Frontmatter)(parsed).pipe(
    Effect.mapError((error) => new PolicyError({ message: `${name}: invalid frontmatter: ${error.message}` }))
  )
  if (select === undefined) {
    return yield* new PolicyError({ message: `${name}: frontmatter needs a select command that picks what the rule judges` })
  }
  return {
    name,
    body,
    select,
    ...(criteria === undefined ? {} : { criteria }),
    ...(limit === undefined ? {} : { limit: { max: limit.max, per: limit.per ?? "file" } })
  } satisfies Policy
})

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

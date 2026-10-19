import { Effect, FileSystem } from "effect"

/** A complete file selected for linting, with its cwd-relative path. */
export interface SourceFile {
  readonly path: string
  readonly source: string
}

/** Reads every file matching `patterns`, deduplicated and sorted by path. */
export const readSources = Effect.fn("readSources")(function*(patterns: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const matched = yield* Effect.forEach(patterns, (pattern) =>
    Effect.promise(() => Array.fromAsync(new Bun.Glob(pattern).scan({ onlyFiles: true }))))
  const paths = [...new Set(matched.flat())].sort()
  return yield* Effect.forEach(paths, (path) =>
    fs.readFileString(path).pipe(Effect.map((source): SourceFile => ({ path, source }))))
})

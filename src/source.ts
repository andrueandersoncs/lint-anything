import { Effect, FileSystem } from "effect"

/**
 * Expands `patterns` to the cwd-relative paths of the files they match, deduplicated and sorted. Each file
 * must be readable: selectors read them.
 */
export const readPaths = Effect.fn("readPaths")(function*(patterns: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const matched = yield* Effect.forEach(patterns, (pattern) =>
    Effect.promise(() => Array.fromAsync(new Bun.Glob(pattern).scan({ onlyFiles: true }))))
  const paths = [...new Set(matched.flat())].sort()
  yield* Effect.forEach(paths, (path) => fs.access(path, { readable: true }), { discard: true })
  return paths
})

import { Effect, Runtime, Schema } from "effect"

export class ChangesError extends Schema.TaggedError<ChangesError>()("ChangesError", {
  message: Schema.String
}) {
  override readonly [Runtime.errorExitCode] = 2
}

/**
 * What changed since a git ref, per path relative to the current directory: the changed line ranges
 * (1-based, inclusive) of tracked files, or `"all"` for untracked ones. Deleted lines leave nothing to
 * judge, so a hunk that only deletes contributes no range.
 */
export type Changes = ReadonlyMap<string, ReadonlyArray<readonly [number, number]> | "all">

export const changedSince = Effect.fn("changedSince")(function*(ref: string) {
  const diff = yield* Effect.promise(() => Bun.$`git diff --relative --no-color --unified=0 ${ref} --`.quiet().nothrow())
  if (diff.exitCode !== 0) {
    return yield* new ChangesError({ message: `git diff ${ref} failed: ${diff.stderr.toString().trim().slice(0, 300)}` })
  }
  const untracked = yield* Effect.promise(() => Bun.$`git ls-files --others --exclude-standard`.quiet().nothrow())
  const changes = new Map<string, Array<readonly [number, number]> | "all">()
  let path: string | undefined
  for (const line of diff.stdout.toString().split("\n")) {
    if (line.startsWith("+++ ")) {
      path = line === "+++ /dev/null" ? undefined : line.slice("+++ b/".length)
      if (path !== undefined && !changes.has(path)) changes.set(path, [])
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk === null || path === undefined) continue
    const start = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    const ranges = changes.get(path)
    if (count > 0 && ranges !== "all") ranges!.push([start, start + count - 1])
  }
  for (const file of untracked.stdout.toString().split("\n")) if (file !== "") changes.set(file, "all")
  return changes as Changes
})

/** Whether `lines` of `path` (or, without lines, any part of it) changed. */
export const touches = (changes: Changes, path: string, lines?: readonly [number, number]) => {
  const ranges = changes.get(path)
  if (ranges === undefined) return false
  if (ranges === "all" || lines === undefined) return ranges === "all" || ranges.length > 0
  return ranges.some(([start, end]) => lines[0] <= end && start <= lines[1])
}

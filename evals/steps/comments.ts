// Eval selector: each contiguous comment block in TS/JS/Py/Go files (paths on stdin), together with up to
// 8 lines of the code that follows it as `following code` evidence so the judge can spot comments that
// contradict the implementation (not just the single next line).
import { inputPaths } from "./step.ts"

const commentLine = /^\s*(?:\/\/|#|\/\*|\*)/
const maxAfter = 8

export const run = async (args: ReadonlyArray<string>) => {
  const paths = await inputPaths("comments", args)
  const out: Array<string> = []

  for (const path of paths) {
    const source = await Bun.file(path).text()
    const lines = source.split("\n")
    let i = 0
    while (i < lines.length) {
      if (!commentLine.test(lines[i]!)) {
        i++
        continue
      }
      const start = i
      while (i < lines.length && commentLine.test(lines[i]!)) i++
      const endComment = i - 1
      // Include up to `maxAfter` lines after the comment (stopping at a blank line once at least 3 code lines
      // are shown, so a doc comment includes the signature and first lines of the body).
      const after: Array<string> = []
      let codeLines = 0
      for (let j = i; j < lines.length && after.length < maxAfter; j++) {
        const line = lines[j]!
        if (line.trim() === "" && codeLines >= 3) break
        after.push(line)
        if (line.trim() !== "") codeLines++
      }
      const firstAfter = i < lines.length ? i : endComment
      const commentText = lines.slice(start, endComment + 1).join("\n")
      const nextLine = i < lines.length ? lines[i]! : ""
      const text = nextLine === "" ? commentText : `${commentText}\n${nextLine}`
      out.push(JSON.stringify({
        id: `${path}:${start + 1}`,
        path,
        lines: [start + 1, firstAfter + 1],
        ...(after.length > 1 ? { "following code": after.join("\n") } : {}),
        text
      }))
    }
  }

  if (out.length > 0) await new Promise<void>((resolve) => process.stdout.write(`${out.join("\n")}\n`, () => resolve()))
}

if (import.meta.main) await run(Bun.argv.slice(2))

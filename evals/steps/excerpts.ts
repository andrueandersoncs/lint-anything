// Eval selector: cuts each file given as an argument into consecutive excerpts of at most <bytes> bytes, the
// cutter the CLI used before selectors were required (evals/RESEARCH.md, H19): cut before a top-level
// declaration where possible, else before a line after a blank line, else where the bytes run out. A file
// within <bytes> is one excerpt. Each excerpt is one item whose text is the question the excerpt CLI asked
// about it (`path: <path> (lines a-b of n)`, then `file:` and the excerpt), so a policy with this selector,
// that CLI's guidance in its body, and its criteria sends that CLI's requests: the floor a selector built
// for a rule has to beat.
//   bun "$EVAL_STEPS/excerpts.ts" <bytes> <file> …
const [limit, ...paths] = Bun.argv.slice(2)
const maxBytes = Number(limit)
if (!Number.isInteger(maxBytes) || maxBytes < 1) {
  console.error("excerpts.ts: first argument must be the excerpt size in bytes")
  process.exit(2)
}

const excerpts = (source: string): Array<{ start: number; end: number; text: string }> => {
  const lines = source.split("\n")
  if (Buffer.byteLength(source) <= maxBytes) return [{ start: 1, end: lines.length, text: source }]
  const afterBlank = (index: number) => index > 0 && lines[index - 1]!.trim() === "" && lines[index]!.trim() !== ""
  const topLevel = (index: number) => afterBlank(index) && !/^[\s})\]]/.test(lines[index]!)
  const result: Array<{ start: number; end: number; text: string }> = []
  for (let start = 0; start < lines.length;) {
    let end = start
    let bytes = 0
    while (end < lines.length && bytes + Buffer.byteLength(lines[end]!) + 1 <= maxBytes) {
      bytes += Buffer.byteLength(lines[end]!) + 1
      end++
    }
    if (end < lines.length) {
      const cutAt = (test: (index: number) => boolean) => {
        for (let index = end; index > start; index--) if (test(index)) return index
        return -1
      }
      const cut = [cutAt(topLevel), cutAt(afterBlank)].find((index) => index > start)
      end = cut ?? Math.max(end, start + 1)
    }
    result.push({ start: start + 1, end, text: lines.slice(start, end).join("\n") })
    start = end
  }
  return result
}

const items: Array<string> = []
for (const path of paths) {
  const source = await Bun.file(path).text()
  const count = source.split("\n").length
  for (const { start, end, text } of excerpts(source)) {
    if (text === "") continue
    const location = start === 1 && end === count ? path : `${path} (lines ${start}-${end} of ${count})`
    items.push(JSON.stringify({ id: `${path}:${start}`, path, lines: [start, end], text: `path: ${location}\n\nfile:\n${text}` }))
  }
}
if (items.length > 0) await new Promise<void>((resolve) => process.stdout.write(`${items.join("\n")}\n`, () => resolve()))

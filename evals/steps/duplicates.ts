// Eval selector: each file whose path it reads on stdin cut into excerpts of about 1 KB (cuts preferred before
// top-level declarations, then after blank lines), one item per excerpt, numbered. Evidence:
// `similar` — the other places in the file that share the most token sequences with the excerpt (exact
// runs of 4 tokens, ignoring runs that are everywhere in the file), shown numbered; `repeated elsewhere` —
// the excerpt's non-trivial lines and its string and number literals that also appear elsewhere in the
// file. For rules about repeated logic or knowledge within a file.
import { languageOf, numbered } from "./module.ts"
import { inputPaths } from "./step.ts"

const maxBytes = 1000
const gram = 4
// A token run found in more places than this is idiom (`if err != nil {`), not a copy.
const maxCopies = 6
const maxRegionLines = 30

/** Consecutive excerpts of at most `maxBytes`, as 0-based inclusive line ranges. */
const excerpts = (lines: ReadonlyArray<string>) => {
  const afterBlank = (index: number) => index > 0 && lines[index - 1]!.trim() === "" && lines[index]!.trim() !== ""
  const topLevel = (index: number) => afterBlank(index) && !/^[\s})\]]/.test(lines[index]!)
  const result: Array<readonly [number, number]> = []
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
    result.push([start, end - 1])
    start = end
  }
  return result.filter(([from, to]) => lines.slice(from, to + 1).some((line) => line.trim() !== ""))
}

const tokenPattern = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|[A-Za-z_$][\w$]*|\d[\w.]*|[^\s\w]/g
const trivialLiteral = /^(?:["'`].{0,4}["'`]|\d|10|100|0x0|0\.\d)$/
// A line worth reporting when it recurs: not a brace, a short statement, an import, or Go's error check.
const normalize = (line: string) => line.trim().replace(/\s+/g, " ")
const trivialLine = (line: string) =>
  line.length < 24 || /^(?:import\b|from\s+\S+\s+import\b|if err != nil\b|return (?:nil, )?err\b|\} else \{$|[})\]]+[;,]?$)/.test(line)

const items: Array<string> = []
for (const path of await inputPaths("duplicates", Bun.argv.slice(2))) {
  const language = languageOf(path)
  const source = await Bun.file(path).text()
  if (source.trim() === "") continue
  const lines = source.replace(/\n$/, "").split("\n")
  const comment = language === "py" ? /^\s*#/ : /^\s*(?:\/\/|\/\*|\*)/
  // Tokens of code lines (comment-only lines skipped), each with its line.
  const tokens: Array<{ readonly text: string; readonly line: number }> = []
  for (const [line, text] of lines.entries()) {
    if (comment.test(text)) continue
    for (const match of text.matchAll(tokenPattern)) tokens.push({ text: match[0], line })
  }
  const grams = new Map<string, Array<number>>() // gram → token indexes where it starts
  for (let i = 0; i + gram <= tokens.length; i++) {
    const key = tokens.slice(i, i + gram).map((t) => t.text).join("\u0000")
    let at = grams.get(key)
    if (at === undefined) grams.set(key, at = [])
    at.push(i)
  }
  const literals = new Map<string, Array<number>>() // literal → lines
  for (const { text, line } of tokens) {
    if (!/^["'`\d]/.test(text) || trivialLiteral.test(text)) continue
    const at = literals.get(text) ?? []
    if (at[at.length - 1] !== line) at.push(line)
    literals.set(text, at)
  }
  const lineCopies = new Map<string, Array<number>>() // normalized line → lines
  for (const [line, text] of lines.entries()) {
    const key = normalize(text)
    if (trivialLine(key) || comment.test(text)) continue
    lineCopies.set(key, [...(lineCopies.get(key) ?? []), line])
  }
  for (const [key, at] of lineCopies) if (at.length < 2) lineCopies.delete(key)
  let first = 0
  for (const [from, to] of excerpts(lines)) {
    while (first < tokens.length && tokens[first]!.line < from) first++
    // Votes: for each line elsewhere, the excerpt grams that recur there.
    const votes = new Map<number, Set<number>>()
    let own = 0
    for (let i = first; i + gram <= tokens.length && tokens[i]!.line <= to; i++) {
      if (tokens[i + gram - 1]!.line > to) break
      own++
      const key = tokens.slice(i, i + gram).map((t) => t.text).join("\u0000")
      const at = grams.get(key)!
      if (at.length > maxCopies) continue
      for (const other of at) {
        const line = tokens[other]!.line
        if (line >= from && line <= to) continue
        let set = votes.get(line)
        if (set === undefined) votes.set(line, set = new Set())
        set.add(i)
      }
    }
    // Group voted lines into regions (gaps of up to 3 lines) and rank them by distinct grams shared.
    const regions: Array<{ from: number; to: number; shared: Set<number> }> = []
    for (const line of [...votes.keys()].sort((a, b) => a - b)) {
      const last = regions[regions.length - 1]
      if (last !== undefined && line - last.to <= 4) {
        last.to = line
        for (const g of votes.get(line)!) last.shared.add(g)
      } else regions.push({ from: line, to: line, shared: new Set(votes.get(line)) })
    }
    const strong = regions
      .map((r) => ({ ...r, share: own === 0 ? 0 : r.shared.size / own }))
      .filter((r) => r.shared.size >= 6 && r.share >= 0.1)
      .sort((a, b) => b.shared.size - a.shared.size)
      .slice(0, 2)
    const similar = strong.length === 0
      ? "No code outside this excerpt shares more than a few token sequences with it."
      : strong.map((r) =>
        `Lines ${r.from + 1}-${r.to + 1} share ${Math.round(r.share * 100)}% of this excerpt's 4-token sequences:\n${numbered(lines, r.from, r.to, maxRegionLines)}`
      ).join("\n\n")
    const repeated: Array<string> = []
    for (let line = from; line <= to; line++) {
      const at = lineCopies.get(normalize(lines[line]!))
      if (at === undefined) continue
      const outside = at.filter((other) => other < from || other > to)
      if (outside.length === 0 || at.find((other) => other >= from && other <= to) !== line) continue
      repeated.push(`line ${line + 1} \`${lines[line]!.trim().slice(0, 100)}\` also on line ${outside.slice(0, 5).map((l) => l + 1).join(", ")}${outside.length > 5 ? ", …" : ""}`)
    }
    for (const [literal, at] of literals) {
      const inside = at.filter((line) => line >= from && line <= to)
      const outside = at.filter((line) => line < from || line > to)
      if (inside.length === 0 || outside.length === 0) continue
      repeated.push(`literal ${literal.slice(0, 80)} (line ${inside.map((l) => l + 1).join(", ")}) also on line ${outside.slice(0, 5).map((l) => l + 1).join(", ")}${outside.length > 5 ? ", …" : ""}`)
    }
    items.push(JSON.stringify({
      id: `${path}:${from + 1}-${to + 1}`,
      path,
      lines: [from + 1, to + 1],
      similar,
      "repeated elsewhere": repeated.slice(0, 10).join("\n"),
      text: numbered(lines, from, to)
    }))
  }
}
if (items.length > 0) await new Promise<void>((resolve) => process.stdout.write(`${items.join("\n")}\n`, () => resolve()))

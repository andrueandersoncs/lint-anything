// Eval selector: each file given as an argument becomes one item holding the whole file. For rules about a
// file as a whole. Empty files emit nothing.
const items: Array<string> = []
for (const path of Bun.argv.slice(2)) {
  const text = await Bun.file(path).text()
  if (text.trim() === "") continue
  const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
  items.push(JSON.stringify({ id: path, path, lines: [1, Math.max(1, lines)], text }))
}
if (items.length > 0) await new Promise<void>((resolve) => process.stdout.write(`${items.join("\n")}\n`, () => resolve()))

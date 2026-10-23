// Eval selector: each public declaration of a file (exported top-level function, type, class, constant, or
// variable; public method or property of an exported class) as one item, with where else in the file it
// is referenced (`references`) and the file's public and non-public names (`module`). For rules about a
// module's public surface. Paths are read on stdin.
import { type Declaration, declarations, enclosing, numbered, references, scan, selectFiles } from "./module.ts"

const maxLines = 25
const maxNames = 40
const surface = new Set(["function", "class", "interface", "type", "enum", "const", "let", "var", "variable", "namespace", "struct", "method", "property", "getter", "setter"])

const describe = (d: Declaration) => `${d.owner === undefined ? "" : `${d.owner}.`}${d.name}`
const listNames = (ds: ReadonlyArray<Declaration>) =>
  ds.length === 0 ? "none" : `${ds.slice(0, maxNames).map(describe).join(", ")}${ds.length > maxNames ? `, … (${ds.length - maxNames} more)` : ""}`

await selectFiles((path, source, language) => {
  const scanned = scan(source, language)
  const all = declarations(scanned, language)
  const ownerExported = new Map(all.filter((d) => d.owner === undefined).map((d) => [d.name, d.exported]))
  const topLevel = all.filter((d) => d.owner === undefined)
  const notes: Array<string> = []
  if (language === "go" && /(^|\/)internal\//.test(path)) notes.push("The file is in an `internal/` package.")
  if (language === "py" && path.split("/").some((part) => part.startsWith("_") && !part.startsWith("__"))) notes.push("The file is in a private (underscore-named) module.")
  if (language === "py" && /^__all__\s*(?::[^=]*)?=/m.test(source)) notes.push("The file declares `__all__`.")
  const module = [
    ...notes,
    `Public top-level names: ${listNames(topLevel.filter((d) => d.exported))}.`,
    `Non-public top-level names: ${listNames(topLevel.filter((d) => !d.exported))}.`
  ].join("\n")
  return all
    .filter((d) => d.exported && surface.has(d.kind) && !d.name.startsWith("__"))
    .filter((d) => d.owner === undefined || ownerExported.get(d.owner) !== false)
    .map((d) => {
      const member = d.owner !== undefined
      // A Go type's own method receivers are not uses of it.
      const uses = references(scanned, d.name, d.start, d.end, member)
        .filter((line) => !all.some((m) => m.start === line && m.kind === "method" && m.owner === d.name && language === "go"))
      const users = uses.map((line) => {
        const by = enclosing(all, line)
        const where = by === undefined
          ? "at top level"
          : `in ${describe(by)} (${by.kind}, ${by.exported ? "public" : "not public"})`
        return `line ${line + 1} ${where}: ${scanned.lines[line]!.trim().slice(0, 100)}`
      })
      const shown = users.slice(0, 6)
      if (users.length > shown.length) shown.push(`… (${users.length - shown.length} more lines)`)
      const kind = member ? `${d.kind} of ${d.owner}` : d.kind
      // A class item is its header (up to its first member) and a list of its members, so it doesn't overlap them.
      const members = d.kind === "class" ? all.filter((m) => m.owner === d.name && m.start > d.start && m.end <= d.end) : []
      const end = members.length > 0 ? Math.max(d.start, members[0]!.start - 1) : d.end
      const memberList = members.length === 0
        ? ""
        : `\n(members: public ${listNames(members.filter((m) => m.exported))}; non-public ${listNames(members.filter((m) => !m.exported))})`
      return {
        id: `${path}:${d.start + 1}:${describe(d)}`,
        path,
        lines: [d.start + 1, end + 1],
        references: `Public ${kind} \`${describe(d)}\`. ${
          uses.length === 0 ? "Not referenced anywhere else in this file." : `Referenced on ${uses.length} other line(s) of this file:\n${shown.join("\n")}`
        }`,
        module,
        text: numbered(scanned.lines, d.start, end, maxLines) + memberList
      }
    })
})

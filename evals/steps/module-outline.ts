// Eval selector: each file whose path it reads on stdin as one item spanning the whole file, whose text is the
// file's outline: what it imports, then each top-level declaration (line, kind, signature, and the first
// line of its doc comment or docstring) with the names of a class's or struct's members. For rules about
// what a file is about as a whole.
import { declarations, scan, selectFiles } from "./module.ts"

const maxMembers = 25

await selectFiles((path, source, language) => {
  const scanned = scan(source, language)
  const { lines, code } = scanned
  const all = declarations(scanned, language)
  const doc = (start: number) => {
    // A Python docstring on the line after the header, else the comment block just above.
    if (language === "py") {
      for (let i = start + 1; i < Math.min(lines.length, start + 6); i++) {
        const match = /^\s*[rbuf]?("""|''')\s*(.*?)\s*(?:\1)?\s*$/.exec(lines[i]!)
        if (match !== null) return match[2]! || (lines[i + 1] ?? "").trim()
        if (code[i]!.trim().endsWith(":")) continue
        if (code[i]!.trim() !== "" && scanned.depth[i] === 0) break
      }
      return ""
    }
    let i = start - 1
    while (i >= 0 && code[i]!.trim() === "" && lines[i]!.trim() !== "") i--
    const comment = lines.slice(i + 1, start).map((line) => line.trim().replace(/^(?:\/\/+|\/\*+|\*+\/?|#)\s*/, "")).filter((line) => line !== "" && !line.startsWith("@"))
    return comment[0] ?? ""
  }
  const imports = new Set<string>()
  const importPattern = language === "go"
    ? /^\s*(?:import\s+)?(?:\w+\s+)?"([^"]+)"\s*$/
    : language === "py"
    ? /^\s*(?:from\s+(\S+)\s+import|import\s+([\w.]+))/
    : /^\s*(?:import\b.*?from\s+|import\s+|(?:const|let|var)\s+.*?=\s*require\()\s*["'`]([^"'`]+)["'`]/
  const firstDeclaration = all[0]?.start ?? lines.length
  for (let i = 0; i < lines.length; i++) {
    if (language === "go" && i >= firstDeclaration) break
    const match = importPattern.exec(lines[i]!)
    if (match !== null) imports.add(match[1] ?? match[2]!)
  }
  const out: Array<string> = [`${path} (${lines.length} lines)`]
  if (imports.size > 0) out.push(`imports: ${[...imports].join(", ")}`)
  out.push("")
  const declared = new Set(all.filter((d) => d.owner === undefined).map((d) => d.name))
  for (const d of all) {
    // Go methods are listed under their type, unless the type is declared in another file.
    if (d.owner !== undefined && !(language === "go" && !declared.has(d.owner))) continue
    const comment = doc(d.start)
    out.push(`${d.start + 1}-${d.end + 1}: ${d.signature.replace(/\s*\{\s*$/, "")}${comment === "" ? "" : `  — ${comment.slice(0, 120)}`}`)
    const members = all.filter((m) => m.owner === d.name && m.kind !== "constructor" && m.start >= d.start && (language === "go" || m.end <= d.end))
    if (members.length === 0) continue
    const fields = members.filter((m) => ["field", "property", "attribute"].includes(m.kind) && !(language === "py" && m.kind === "property"))
    const methods = members.filter((m) => !fields.includes(m))
    const list = (ms: typeof members) => `${ms.slice(0, maxMembers).map((m) => m.name).join(", ")}${ms.length > maxMembers ? `, … (${ms.length - maxMembers} more)` : ""}`
    if (fields.length > 0) out.push(`    fields: ${list(fields)}`)
    if (methods.length > 0) out.push(`    methods: ${list(methods)}`)
  }
  return [{ id: path, path, lines: [1, lines.length], text: out.join("\n") }]
})

// Eval selector: the places where a file can hand out or take in mutable state, one item each, with the
// owner's state as evidence (`state`) and what was found (`finding`):
// - a class's or struct's public fields (Go exported struct fields, TypeScript public properties and
//   parameter properties, Python public attributes);
// - each method or function that returns one of its owner's fields (or a module-level mutable value)
//   directly, or stores one of its parameters in a field;
// - each module-level mutable value (a list, map, object, or set literal bound to a name), public or used by
//   a function that returns it.
// For rules about leaking internal mutable state. Paths are given as arguments.
import { type Declaration, declarations, numbered, scan, type Scanned, selectFiles, wordPattern } from "./module.ts"

const maxLines = 30
const maxState = 25
// Go field types that are copied on return.
const goValue = /^(?:u?int\d*|string|bool|float\d+|complex\d+|byte|rune|error|uintptr|time\.(?:Duration|Time)|atomic\.\w+|sync\.\w+)$/
// TypeScript and Python fields declared or initialized as scalars.
const scalarField = /:\s*(?:number|string|boolean|bigint|int|str|bool|float)\s*(?:[;=]|$)|=\s*(?:-?\d[\d_.]*|["'`][^"'`]*["'`]|true|false|True|False)\s*;?\s*$/
/** Whether code ending in `prefix` is inside a call's arguments (`len(`, `copy(`, `fmt.Sprintf(x, `). */
const insideCall = (prefix: string) => {
  let open = 0
  for (let i = prefix.length - 1; i >= 0; i--) {
    const c = prefix[i]!
    if (c === ")" || c === "]" || c === "}") open++
    else if (c === "(" || c === "[" || c === "{") {
      if (open > 0) open--
      else return c === "(" && /[\w$]\s*$/.test(prefix.slice(0, i)) && !/\breturn\s*$/.test(prefix.slice(0, i))
    }
  }
  return false
}
const mutableLiteral = {
  go: /^(?:\[\]|map\[|&|\w+(?:\.\w+)?\{|make\()/,
  ts: /^(?:\[|\{|new\s+(?:Map|Set|Array|WeakMap)\b)/,
  py: /^(?:\[|\{|(?:dict|list|set|defaultdict|OrderedDict|deque)\()/
}

interface Field {
  readonly name: string
  readonly line: number
  readonly exported: boolean
  /** Declared type or initial value, as written. */
  readonly detail: string
}

/** Parameter names in a signature's text (between the first `(` and the body), except those of scalar type. */
const parameterNames = (signature: string, language: string) => {
  const open = signature.indexOf("(")
  if (open < 0) return new Set<string>()
  const inner = signature.slice(open + 1)
  const names = new Set<string>()
  if (language === "go") {
    for (const match of inner.matchAll(/(?:^|[(,])\s*(\w+)(?=\s*(?:,|\s+[\w*[\].{}]))/g)) names.add(match[1]!)
    for (const match of inner.matchAll(/(\w+)\s+(?:u?int\d*|string|bool|float\d+|byte|rune|time\.Duration)\b/g)) names.delete(match[1]!)
  } else {
    for (const match of inner.matchAll(/(?:^|[(,])\s*(?:(?:public|private|protected|readonly|override)\s+)*\*{0,2}(\w+)\s*[?:=,)]/g)) names.add(match[1]!)
    for (const match of inner.matchAll(/(\w+)\s*\??:\s*(?:number|string|boolean|bigint|int|str|bool|float|bytes)\b(?!\s*\[)/g)) names.delete(match[1]!)
  }
  names.delete("self")
  names.delete("this")
  return names
}

const signatureText = (scanned: Scanned, d: Declaration) => {
  // Up to the line that opens the body.
  const parts: Array<string> = []
  for (let i = d.start; i <= d.end && i < d.start + 15; i++) {
    parts.push(scanned.code[i]!)
    if (/[{:]\s*$/.test(scanned.code[i]!) && scanned.depth[i + 1] !== undefined && parts.join("").split("(").length === parts.join("").split(")").length) break
  }
  return parts.join(" ")
}

await selectFiles((path, source, language) => {
  const scanned = scan(source, language)
  const { lines, code } = scanned
  const all = declarations(scanned, language)
  const items: Array<Record<string, unknown>> = []
  const item = (key: string, from: number, to: number, text: string, state: string, finding: string) =>
    items.push({ id: `${path}:${from + 1}:${key}`, path, lines: [from + 1, to + 1], state, finding, text })

  // Each owner's fields.
  const owners = new Map<string, { decl: Declaration | undefined; fields: Array<Field>; methods: Array<Declaration> }>()
  const ownerOf = (name: string) => {
    let owner = owners.get(name)
    if (owner === undefined) {
      owners.set(name, owner = { decl: all.find((d) => d.owner === undefined && d.name === name && (d.kind === "class" || d.kind === "struct")), fields: [], methods: [] })
    }
    return owner
  }
  for (const d of all) {
    if (d.owner === undefined) continue
    const owner = ownerOf(d.owner)
    if (d.kind === "field" || (d.kind === "property" && language !== "py") || d.kind === "attribute") {
      owner.fields.push({ name: d.name.replace(/^#/, ""), line: d.start, exported: d.exported, detail: lines[d.start]!.trim().slice(0, 140) })
    } else if (["method", "constructor", "getter", "setter", "property"].includes(d.kind)) owner.methods.push(d)
  }
  for (const owner of owners.values()) {
    for (const m of owner.methods) {
      if (language === "ts" && m.kind === "constructor") {
        for (let i = m.start; i <= Math.min(m.end, m.start + 15); i++) {
          for (const match of code[i]!.matchAll(/\b(public|private|protected|readonly)\s+(?:readonly\s+)?(\w+)\s*[?:]/g)) {
            owner.fields.push({ name: match[2]!, line: i, exported: match[1] === "public" || match[1] === "readonly", detail: `constructor parameter property: ${match[0]}` })
          }
          if (/\{\s*$/.test(code[i]!)) break
        }
      }
      if (language === "py") {
        // The first assignment of each attribute, besides any class-level declaration of it.
        for (let i = m.start; i <= m.end; i++) {
          const match = /^\s*self\.(\w+)\s*(?::[^=]+)?=(?!=)\s*(.*)$/.exec(code[i]!)
          if (match === null || owner.fields.some((f) => f.name === match[1] && f.detail.startsWith("self."))) continue
          owner.fields.push({ name: match[1]!, line: i, exported: !match[1]!.startsWith("_"), detail: lines[i]!.trim().slice(0, 140) })
        }
      }
    }
  }
  const stateOf = (name: string) => {
    const owner = owners.get(name)!
    const kind = owner.decl?.kind ?? "type"
    const fields = [...owner.fields].sort((a, b) => a.line - b.line)
    const shown = fields.slice(0, maxState).map((f) => `${f.line + 1}: ${f.detail}`)
    if (fields.length > maxState) shown.push(`… (${fields.length - maxState} more fields)`)
    const locked = fields.some((f) => /\b(?:Mutex|RWMutex|Lock|RLock)\b|threading\.|asyncio\.Lock/.test(f.detail))
    const publicMethods = owner.methods.filter((m) => m.exported && m.kind !== "constructor").length
    return [
      `${kind} ${name}${owner.decl === undefined ? "" : ` (${owner.decl.exported ? "public" : "not public"}, line ${owner.decl.start + 1})`}: ${owner.methods.length} methods in this file (${publicMethods} public)${locked ? ", guarded by a lock" : ""}.`,
      fields.length === 0 ? "No fields found." : `Fields:\n${shown.join("\n")}`
    ].join("\n")
  }

  // Module-level mutable values.
  const moduleValues = new Map<string, Declaration>()
  for (const d of all) {
    if (d.owner !== undefined || !["var", "let", "const", "variable"].includes(d.kind)) continue
    if (language === "go" && d.kind === "const") continue
    const value = /=\s*(.*)$/.exec(code[d.start]!)?.[1]?.trim() ?? (language === "go" ? code[d.start]!.trim().replace(/^var\s+/, "").replace(/^\w+\s+/, "") : "")
    if (!mutableLiteral[language].test(value) && !(language === "go" && /^(?:\[\]|map\[)/.test(value))) continue
    moduleValues.set(d.name, d)
  }
  const returnsModuleValue = new Set<string>()
  const moduleState = (d: Declaration) => `Module-level ${d.kind} \`${d.name}\` (${d.exported ? "public" : "not public"}), line ${d.start + 1}:\n${numbered(lines, d.start, d.end, 8)}`

  // Methods and functions that return a field or module value directly, or store a parameter.
  for (const d of all) {
    if (!["method", "getter", "setter", "constructor", "function", "property"].includes(d.kind)) continue
    if (d.kind === "property" && language === "ts") continue
    const owner = d.owner === undefined ? undefined : owners.get(d.owner)
    const receiver = language === "go" ? /^func\s*\(\s*(\w+)/.exec(code[d.start]!)?.[1] : language === "py" ? "self" : "this"
    const findings: Array<string> = []
    if (owner !== undefined && receiver !== undefined) {
      const fieldByName = new Map(owner.fields.map((f) => [f.name, f]))
      const params = parameterNames(signatureText(scanned, d), language)
      // Locals taken from the receiver's state: `x := s.m[k]`, `const x = this.items.get(k)`, `x, err := s.get(k)`.
      const derived = new Map<string, number>()
      const taken = `${receiver}\\.#?\\w+(?:\\s*\\[|\\.(?:get|Get|Load)\\(|\\s*;?\\s*$)|${receiver}\\.(?:get|load|lookup|find|fetch)\\w*\\(`
      const localPattern = language === "go"
        ? new RegExp(`^\\s*(\\w+)(?:\\s*,\\s*\\w+)*\\s*:?=\\s*(?:${taken})`, "i")
        : language === "ts"
        ? new RegExp(`^\\s*(?:const|let|var)\\s+(\\w+)\\b[^=]*=\\s*(?:${taken})`, "i")
        : new RegExp(`^\\s*(\\w+)\\s*(?::[^=]+)?=(?!=)\\s*(?:${taken})`, "i")
      for (let i = d.start; i <= d.end; i++) {
        const local = localPattern.exec(code[i]!)
        if (local !== null && local[1] !== receiver && local[1] !== "_") derived.set(local[1]!, i)
      }
      params.delete(receiver)
      const fieldUse = new RegExp(`(&?)\\b${receiver}\\.#?(\\w+)(?![\\w$(.\\[])`, "g")
      for (let i = d.start; i <= d.end; i++) {
        const text = code[i]!
        const returning = /\breturn\b/.test(text)
        const seen = new Set<string>()
        for (const use of text.matchAll(fieldUse)) {
          const name = use[2]!
          if (seen.has(name) || (!returning && use[1] === "") || insideCall(text.slice(0, use.index))) continue
          // `x.f = …` assigns the field; that's not handing it out.
          if (new RegExp(`\\b${receiver}\\.#?${name}\\s*(?::[^=]+)?=(?!=)`).test(text) && !returning) continue
          const field = fieldByName.get(name)
          const type = field === undefined ? "" : field.detail.replace(new RegExp(`^${field.name}\\s+`), "")
          if (use[1] === "" && field !== undefined && (language === "go" ? goValue.test(type.split(/\s/)[0] ?? "") : scalarField.test(field.detail))) continue
          seen.add(name)
          const declared = field === undefined ? "" : ` (declared at line ${field.line + 1}: ${field.detail})`
          findings.push(
            use[1] === "&"
              ? `Line ${i + 1} takes the address of the field \`${name}\`${declared}.`
              : `Line ${i + 1} returns the field \`${name}\`${declared}.`
          )
        }
        if (returning) {
          for (const [local, at] of derived) {
            if (new RegExp(`\\breturn\\b.*\\b${local}\\b(?![\\w$(])`).test(text) && !seen.has(local)) {
              seen.add(local)
              findings.push(`Line ${i + 1} returns \`${local}\` (or part of it), taken from the receiver's state at line ${at + 1}: ${lines[at]!.trim().slice(0, 120)}`)
            }
          }
        }
        const stored = new RegExp(`\\b${receiver}\\.#?(\\w+)\\s*(?::[^=]+)?=(?!=)\\s*(.+?)\\s*;?\\s*$`).exec(text)
        if (stored !== null) {
          const param = [...params].find((p) => new RegExp(`(?<![\\w$.])${p}(?![\\w$])`).test(stored[2]!))
          if (param !== undefined) findings.push(`Line ${i + 1} stores \`${stored[2]!.slice(0, 80)}\` (from the parameter \`${param}\`) in the field \`${stored[1]}\`.`)
        }
      }
      for (const f of owner.fields) {
        if (d.kind === "constructor" && f.detail.startsWith("constructor parameter property") && f.line >= d.start && f.line <= d.end) {
          findings.push(`Line ${f.line + 1} makes the parameter \`${f.name}\` a field (${f.exported ? "publicly readable" : "not public"}), stored as given.`)
        }
      }
    }
    for (const [name, value] of moduleValues) {
      for (let i = d.start; i <= d.end; i++) {
        const text = code[i]!
        if (!wordPattern(name).test(text)) continue
        if (new RegExp(`\\breturn\\s+${name.replace(/[$]/g, "\\$")}\\s*(?:[,;)]|$)`).test(text) || new RegExp(`(?:\\.\\.\\.|\\*\\*)${name}\\b`).test(text)) {
          findings.push(`Line ${i + 1} returns or spreads the module-level mutable \`${name}\` (line ${value.start + 1}).`)
          returnsModuleValue.add(name)
        }
      }
    }
    if (findings.length === 0) continue
    const state = d.owner !== undefined ? stateOf(d.owner) : [...returnsModuleValue].filter((n) => findings.some((f) => f.includes(`\`${n}\``))).map((n) => moduleState(moduleValues.get(n)!)).join("\n\n")
    item(`${d.owner === undefined ? "" : `${d.owner}.`}${d.name}`, d.start, d.end, numbered(lines, d.start, d.end, maxLines), state, findings.join("\n"))
  }

  // Public fields of each owner.
  for (const [name, owner] of owners) {
    const visible = owner.fields.filter((f) => f.exported)
    if (visible.length === 0 || (owner.decl !== undefined && !owner.decl.exported && language === "go")) continue
    const fieldLines = [...new Set(visible.map((f) => f.line))].sort((a, b) => a - b)
    const from = fieldLines[0]!
    const to = fieldLines[fieldLines.length - 1]!
    const text = language === "go" && owner.decl !== undefined
      ? numbered(lines, owner.decl.start, owner.decl.end, 40)
      : fieldLines.slice(0, maxState).map((line) => `${line + 1}: ${lines[line]!.trim()}`).join("\n")
    const span = language === "go" && owner.decl !== undefined ? [owner.decl.start, owner.decl.end] as const : [from, to] as const
    item(`${name} fields`, span[0], span[1], text, stateOf(name), `Public fields of ${name}: ${visible.map((f) => f.name).join(", ")}.`)
  }

  // Module-level mutable values that are public or handed out.
  for (const [name, d] of moduleValues) {
    if (!d.exported && !returnsModuleValue.has(name)) continue
    item(name, d.start, d.end, numbered(lines, d.start, d.end, maxLines), "", `Module-level mutable ${d.kind} \`${name}\`, ${d.exported ? "public" : "not public"}${returnsModuleValue.has(name) ? ", returned or spread by a function" : ""}.`)
  }
  return items.sort((a, b) => (a.lines as [number, number])[0] - (b.lines as [number, number])[0])
})

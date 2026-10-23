// Shared by the module-* selectors (evals/steps/module-*.ts): a rough, language-aware outline of a Go,
// Python, or TypeScript/JavaScript file — its top-level declarations, the members of its classes and
// structs, and where names are referenced — computed without a parser from strings-and-comments-blanked
// lines and bracket depth. Eval helpers, not part of the CLI.
import { inputPaths } from "./step.ts"

export type Language = "go" | "py" | "ts"

export const languageOf = (path: string): Language | undefined =>
  path.endsWith(".go") ? "go" : path.endsWith(".py") ? "py" : /\.[cm]?[jt]sx?$/.test(path) ? "ts" : undefined

export interface Scanned {
  readonly lines: ReadonlyArray<string>
  /** Each line with string contents and comments replaced by spaces (quotes kept). */
  readonly code: ReadonlyArray<string>
  /** Bracket depth ((, [, {) at the start of each line. */
  readonly depth: ReadonlyArray<number>
}

/** Blanks strings and comments and tracks bracket depth. Line numbers in the result are 0-based indexes. */
export const scan = (source: string, language: Language): Scanned => {
  const lines = source.split("\n")
  const out: Array<string> = []
  const depth: Array<number> = []
  // Context stack: "code" frames count braces so a template literal's `${…}` knows when it closes.
  const stack: Array<{ kind: "code"; braces: number } | { kind: "template" }> = [{ kind: "code", braces: 0 }]
  let level = 0
  let block = false // inside /* */
  let string: string | undefined // open quote (', ", `, ''', """) of a string spanning lines
  let lastSignificant = "" // last non-space code character, to tell a regex literal from division
  for (const line of lines) {
    depth.push(level)
    let text = ""
    let i = 0
    const top = () => stack[stack.length - 1]!
    while (i < line.length) {
      const c = line[i]!
      const two = line.slice(i, i + 2)
      if (block) {
        if (two === "*/") {
          block = false
          text += "  "
          i += 2
        } else {
          text += " "
          i++
        }
        continue
      }
      if (string !== undefined || top().kind === "template") {
        const quote = string ?? "`"
        if (c === "\\" && language !== "go") {
          text += "  "
          i += 2
          continue
        }
        if (quote === "`" && string === undefined && two === "${") {
          stack.push({ kind: "code", braces: 0 })
          text += "${"
          i += 2
          continue
        }
        if (line.startsWith(quote, i)) {
          if (string !== undefined) string = undefined
          else stack.pop()
          text += quote
          i += quote.length
          lastSignificant = "a"
          continue
        }
        text += " "
        i++
        continue
      }
      // code
      if (two === "//" && language !== "py") {
        text += " ".repeat(line.length - i)
        break
      }
      if (c === "#" && language === "py") {
        text += " ".repeat(line.length - i)
        break
      }
      if (two === "/*" && language !== "py") {
        block = true
        text += "  "
        i += 2
        continue
      }
      if (language === "py" && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
        string = line.slice(i, i + 3)
        text += string
        i += 3
        continue
      }
      if (c === '"' || c === "'" || (c === "`" && language === "go")) {
        // A one-line string (Go raw strings and Python strings may not span lines except as above).
        let j = i + 1
        while (j < line.length && line[j] !== c) j += c !== "`" && line[j] === "\\" ? 2 : 1
        if (j >= line.length && c === "`") {
          string = "`"
          text += "`" + " ".repeat(line.length - i - 1)
          break
        }
        text += c + " ".repeat(Math.max(0, Math.min(j, line.length) - i - 1)) + (j < line.length ? c : "")
        i = j + 1
        lastSignificant = "a"
        continue
      }
      if (c === "`") {
        stack.push({ kind: "template" })
        text += "`"
        i++
        continue
      }
      if (c === "/" && language === "ts" && /^$|[(,=:[!&|?{};]$/.test(lastSignificant) && line[i + 1] !== "/") {
        // A regex literal.
        let j = i + 1
        let klass = false
        while (j < line.length && (klass || line[j] !== "/")) {
          if (line[j] === "\\") j++
          else if (line[j] === "[") klass = true
          else if (line[j] === "]") klass = false
          j++
        }
        if (j < line.length) {
          text += "/" + " ".repeat(j - i - 1) + "/"
          i = j + 1
          lastSignificant = "a"
          continue
        }
      }
      const frame = top()
      if (c === "{" && frame.kind === "code") frame.braces++
      if (c === "}" && frame.kind === "code") {
        if (frame.braces === 0 && stack.length > 1) {
          stack.pop()
          text += "}"
          i++
          continue
        }
        frame.braces--
      }
      if ("([{".includes(c)) level++
      if (")]}".includes(c)) level = Math.max(0, level - 1)
      if (c.trim() !== "") lastSignificant = /[\w$]/.test(c) ? (lastSignificant === "" || /[\w$]/.test(lastSignificant) ? lastSignificant + c : c) : c
      if (/^(return|typeof|case|in|of)$/.test(lastSignificant)) lastSignificant = "("
      text += c
      i++
    }
    if (string !== undefined && string.length === 1 && string !== "`") string = undefined
    out.push(text)
  }
  return { lines, code: out, depth }
}

export interface Declaration {
  readonly kind: string
  readonly name: string
  /** 0-based, inclusive. */
  readonly start: number
  readonly end: number
  readonly exported: boolean
  /** For a member: its class, struct, or (Go) receiver type. */
  readonly owner?: string
  /** For a method or function: the first line of its signature. */
  readonly signature: string
}

const indentOf = (line: string) => line.length - line.trimStart().length
const blank = (line: string) => line.trim() === ""
const continues = /(?:[=+\-*/%,.?:&|^<>!(\[{]|=>)\s*$/
const continued = /^\s*(?:[.?:+\-*/%&|^,)\]}>]|=>|&&|\|\||as\b|in\b|instanceof\b|extends\b|implements\b)/

/**
 * The statements at bracket depth `level` (TS/Go) between `from` and `to` (0-based, inclusive): each one's
 * first and last line. A statement runs to the line before the next one starts, trailing blank and
 * comment-only lines dropped. Leading decorators and comments stay with the statement they precede.
 */
const statements = (scanned: Scanned, from: number, to: number, level: number, language: Language) => {
  const { code, depth } = scanned
  const starts: Array<number> = []
  let previous = -1
  for (let i = from; i <= to; i++) {
    if (blank(code[i]!)) continue
    if (language === "py") {
      if (depth[i] !== 0 || indentOf(code[i]!) !== level) {
        previous = i
        continue
      }
      if (previous >= 0 && code[previous]!.trimEnd().endsWith("\\")) {
        previous = i
        continue
      }
    } else {
      if (depth[i] !== level) {
        previous = i
        continue
      }
      if (/^\s*[)\]}]/.test(code[i]!) || continued.test(code[i]!)) {
        previous = i
        continue
      }
      if (previous >= 0 && depth[previous] === level && continues.test(code[previous]!) && !/^\s*@/.test(code[previous]!)) {
        previous = i
        continue
      }
    }
    // A decorator line starts the statement; the declaration under it continues it.
    if (previous >= 0 && starts.length > 0 && starts[starts.length - 1] === previous && /^\s*@/.test(code[previous]!) && depth[previous] === depth[i]) {
      previous = i
      continue
    }
    starts.push(i)
    previous = i
  }
  return starts.map((start, index) => {
    let end = index + 1 < starts.length ? starts[index + 1]! - 1 : to
    while (end > start && blank(code[end]!)) end--
    return { start, end }
  })
}

/** The first code line of a statement (past decorators). */
const head = (scanned: Scanned, start: number, end: number) => {
  for (let i = start; i <= end; i++) if (!blank(scanned.code[i]!) && !/^\s*@/.test(scanned.code[i]!)) return i
  return start
}

/** The body of a class or struct starting at `start`: the lines between its opening brace and close. */
const braceBody = (scanned: Scanned, start: number, end: number) => {
  const level = scanned.depth[start]!
  for (let i = start; i <= end; i++) {
    if (scanned.code[i]!.includes("{") && (scanned.depth[i + 1] ?? 0) > level) return { from: i + 1, to: end, level: level + 1 }
  }
  return undefined
}

const tsTop = /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|const|let|var|namespace)\s+([A-Za-z_$][\w$]*)/
const tsMember =
  /^\s*((?:(?:public|private|protected|static|readonly|abstract|override|async|declare|accessor)\s+)*)(?:(get|set)\s+)?(\*?\s*#?[A-Za-z_$][\w$]*)\s*[?!]?\s*([(<:=;]|$)/

/** Top-level declarations and class/struct members of a file, in order. */
export const declarations = (scanned: Scanned, language: Language): ReadonlyArray<Declaration> => {
  const { code, lines } = scanned
  const result: Array<Declaration> = []
  const last = lines.length - 1
  const signature = (i: number) => lines[i]!.trim().slice(0, 160)
  if (language === "ts") {
    const exportedNames = new Set<string>()
    for (const line of code) {
      for (const match of line.matchAll(/\bexport\s*(?:type\s*)?\{([^}]*)\}/g)) {
        for (const part of match[1]!.split(",")) exportedNames.add(part.trim().split(/\s+/)[0]!)
      }
      const named = /^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/.exec(line) ?? /^\s*module\.exports\s*=\s*([A-Za-z_$][\w$]*)/.exec(line)
      if (named !== null) exportedNames.add(named[1]!)
      const object = /^\s*module\.exports\s*=\s*\{([^}]*)\}/.exec(line)
      if (object !== null) for (const part of object[1]!.split(",")) exportedNames.add(part.trim().split(/[\s:]/)[0]!)
    }
    for (const { start, end } of statements(scanned, 0, last, 0, language)) {
      const at = head(scanned, start, end)
      const match = tsTop.exec(code[at]!.trim())
      const exportsMember = /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/.exec(code[at]!)
      if (exportsMember !== null) {
        result.push({ kind: "const", name: exportsMember[1]!, start, end, exported: true, signature: signature(at) })
        continue
      }
      if (match === null) continue
      const [, exported, kind, name] = match
      result.push({ kind: kind!, name: name!, start, end, exported: exported !== undefined || exportedNames.has(name!), signature: signature(at) })
      if (kind !== "class") continue
      const body = braceBody(scanned, at, end)
      if (body === undefined) continue
      for (const member of statements(scanned, body.from, end, body.level, language)) {
        const memberAt = head(scanned, member.start, member.end)
        const m = tsMember.exec(code[memberAt]!)
        if (m === null) continue
        const modifiers = m[1]!
        const memberName = m[3]!.replace(/^\*\s*/, "")
        if (memberName === "constructor") {
          result.push({ kind: "constructor", name: memberName, start: member.start, end: member.end, exported: true, owner: name!, signature: signature(memberAt) })
          continue
        }
        const isMethod = m[4] === "(" || m[4] === "<" || m[2] !== undefined
        result.push({
          kind: m[2] !== undefined ? `${m[2]}ter` : isMethod ? "method" : "property",
          name: memberName,
          start: member.start,
          end: member.end,
          exported: !/\b(private|protected)\b/.test(modifiers) && !memberName.startsWith("#"),
          owner: name!,
          signature: signature(memberAt)
        })
      }
    }
  } else if (language === "go") {
    const exported = (name: string) => /^[A-Z]/.test(name)
    for (const { start, end } of statements(scanned, 0, last, 0, language)) {
      const text = code[start]!
      let match = /^func\s*\(\s*(?:\w+\s+)?\*?\s*(\w+)(?:\[[^\]]*\])?\s*\)\s*(\w+)/.exec(text)
      if (match !== null) {
        result.push({ kind: "method", name: match[2]!, start, end, exported: exported(match[2]!), owner: match[1]!, signature: signature(start) })
        continue
      }
      match = /^func\s+(\w+)/.exec(text)
      if (match !== null) {
        result.push({ kind: "function", name: match[1]!, start, end, exported: exported(match[1]!), signature: signature(start) })
        continue
      }
      const group = /^(type|var|const)\s*\(/.exec(text)
      const entries = group !== null
        ? statements(scanned, start + 1, end, 1, language).map((entry) => ({ ...entry, kind: group[1]!, text: code[entry.start]!.trim() }))
        : /^(type|var|const)\s+/.test(text)
        ? [{ start, end, kind: /^(\w+)/.exec(text)![1]!, text: text.replace(/^(type|var|const)\s+/, "") }]
        : []
      for (const entry of entries) {
        const names = /^(\w+(?:\s*,\s*\w+)*)/.exec(entry.text)
        if (names === null) continue
        const isStruct = entry.kind === "type" && /^\w+(?:\[[^\]]*\])?\s+struct\s*\{/.test(entry.text)
        for (const name of names[1]!.split(/\s*,\s*/)) {
          result.push({
            kind: isStruct ? "struct" : entry.kind === "type" && /^\w+\s+interface\b/.test(entry.text) ? "interface" : entry.kind,
            name,
            start: entry.start,
            end: entry.end,
            exported: exported(name),
            signature: signature(entry.start)
          })
        }
        if (!isStruct) continue
        const body = braceBody(scanned, entry.start, entry.end)
        if (body === undefined) continue
        const owner = names[1]!
        for (const field of statements(scanned, body.from, entry.end, body.level, language)) {
          const fieldText = code[field.start]!.trim()
          if (fieldText.startsWith("}")) continue
          const fieldNames = /^(\w+(?:\s*,\s*\w+)*)\s+\S/.exec(fieldText)
          const embedded = /^\*?(?:\w+\.)?(\w+)\s*$/.exec(fieldText)
          for (const name of fieldNames !== null ? fieldNames[1]!.split(/\s*,\s*/) : embedded !== null ? [embedded[1]!] : []) {
            result.push({ kind: "field", name, start: field.start, end: field.end, exported: exported(name), owner, signature: signature(field.start) })
          }
        }
      }
    }
  } else {
    let all: Set<string> | undefined
    const allMatch = /^__all__\s*(?::[^=]*)?=\s*[[(]([\s\S]*?)[\])]/m.exec(lines.join("\n"))
    if (allMatch !== null) all = new Set([...allMatch[1]!.matchAll(/["'](\w+)["']/g)].map((m) => m[1]!))
    const isPublic = (name: string) => !name.startsWith("_") && (all === undefined || all.has(name))
    const bodyStart = (at: number, end: number) => {
      let from = at + 1
      while (from <= end && (blank(code[from]!) || scanned.depth[from]! > 0)) from++
      return from
    }
    // `local`: inside a function body, where only classes (not module surface) are recorded.
    const walk = (from: number, to: number, level: number, owner: string | undefined, local: boolean) => {
      for (const { start, end } of statements(scanned, from, to, level, language)) {
        const at = head(scanned, start, end)
        const text = code[at]!.trim()
        const decorators = lines.slice(start, at).map((line) => line.trim()).join(" ")
        let match = /^(?:async\s+)?def\s+(\w+)/.exec(text)
        if (match !== null) {
          const name = match[1]!
          const kind = owner === undefined ? "function" : /@(\w+\.)?(property|cached_property)\b/.test(decorators) ? "property" : "method"
          if (!local) result.push({ kind, name, start, end, exported: owner === undefined ? isPublic(name) : !name.startsWith("_"), owner, signature: signature(at) })
          const from = bodyStart(at, end)
          if (from <= end) walk(from, end, indentOf(code[from]!), undefined, true)
          continue
        }
        match = /^class\s+(\w+)/.exec(text)
        if (match !== null) {
          const name = match[1]!
          const exported = !local && (owner === undefined ? isPublic(name) : !name.startsWith("_"))
          result.push({ kind: "class", name, start, end, exported, owner: local ? undefined : owner, signature: signature(at) })
          const from = bodyStart(at, end)
          if (from <= end) walk(from, end, indentOf(code[from]!), name, false)
          continue
        }
        if (local) continue
        match = /^(\w+)\s*(?::[^=]+)?=(?!=)/.exec(text) ?? /^(\w+)\s*:\s*\S[^=]*$/.exec(text)
        if (match !== null) {
          const name = match[1]!
          result.push({ kind: owner === undefined ? "variable" : "attribute", name, start, end, exported: owner === undefined ? isPublic(name) : !name.startsWith("_"), owner, signature: signature(at) })
        }
      }
    }
    walk(0, last, 0, undefined, false)
  }
  return result
}

/** Matches whole-word occurrences of `name` in code. */
export const wordPattern = (name: string) => new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`, "g")

/** Lines (0-based) outside `start`-`end` whose code mentions `name` as a whole word (or `.name` for a member). */
export const references = (scanned: Scanned, name: string, start: number, end: number, member: boolean) => {
  const pattern = member ? new RegExp(`\\.${name.replace(/[$]/g, "\\$")}(?![\\w$])`) : new RegExp(wordPattern(name).source)
  const found: Array<number> = []
  for (let i = 0; i < scanned.code.length; i++) {
    if (i >= start && i <= end) continue
    if (pattern.test(scanned.code[i]!)) found.push(i)
  }
  return found
}

/** The innermost declaration enclosing 0-based line `line` (members before their class). */
export const enclosing = (declarations: ReadonlyArray<Declaration>, line: number) => {
  let best: Declaration | undefined
  for (const d of declarations) {
    if (d.start <= line && line <= d.end && (best === undefined || d.end - d.start < best.end - best.start)) best = d
  }
  return best
}

/** Lines `from`-`to` (0-based, inclusive) numbered 1-based, at most `max` lines, then a count of the rest. */
export const numbered = (lines: ReadonlyArray<string>, from: number, to: number, max = Number.POSITIVE_INFINITY) => {
  const shown = lines.slice(from, Math.min(to, from + max - 1) + 1).map((line, index) => `${from + index + 1}: ${line}`)
  if (to - from + 1 > max) shown.push(`… (${to - from + 1 - max} more lines)`)
  return shown.join("\n")
}

/** Reads each path on stdin and runs `select` on it, writing the items it returns as JSONL. */
export const selectFiles = async (
  select: (path: string, source: string, language: Language) => ReadonlyArray<Record<string, unknown>>
) => {
  const items: Array<string> = []
  for (const path of await inputPaths("module", Bun.argv.slice(2))) {
    const language = languageOf(path)
    if (language === undefined) continue
    const source = await Bun.file(path).text()
    if (source.trim() === "") continue
    for (const item of select(path, source, language)) items.push(JSON.stringify(item))
  }
  if (items.length > 0) await new Promise<void>((resolve) => process.stdout.write(`${items.join("\n")}\n`, () => resolve()))
}

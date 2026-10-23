// Eval selector: the functions and methods (TS/TSX/JS, Python, Go) of each file whose path it reads on
// stdin, one item each, found with ast-grep. Shared by the function-level corpus policies; flags pick the units and
// the evidence each policy needs:
//   --min-lines N   only functions of at least N lines
//   --chunk N       split a function longer than N lines into equal parts of at most N lines, one item each,
//                   with evidence `function`: its first line and range
//   --outer         only outermost functions (callbacks of describe/suite/context are not units, so the
//                   tests inside them are); default: nested functions too
//   --named         skip anonymous functions (callbacks passed as arguments)
//   --module        also each run of module-level code outside every function (declarations, script code)
//   --flags         only functions with a positional boolean parameter, with evidence `boolean parameters`
//                   (each one, positional or keyword-only) and `call sites` (the file's calls of the function);
//                   plus each call outside the function that passes a bare boolean, as its own one-line item
//   --classes N     also each class (TS/JS, Python) with at least N methods, as an outline: its header, its
//                   fields, and the first line of each method, numbered
//   --globals       evidence `module-level variables used`: the file's module-level variables the function
//                   reads or writes, with their declarations
//   --context       evidence `defined in`: the enclosing class, or the enclosing function of a nested one
//   --docs          include the comment block directly above each function in its item
//   --hidden        evidence `hidden dependencies`: the function's lines that read a clock, a random source,
//                   the environment, or the filesystem, or construct a client-like collaborator
//   --names         evidence `generic or short names declared`: the names the function declares (variables,
//                   parameters, nested functions) that are placeholders (`data`, `res`, `tmpJson`) or, outside
//                   Go, one or two letters long
//   --effects       evidence `name reads as` (for a query-like name such as get… or is…), `side effects`: the
//                   function's lines that change state outside its locals or do I/O, and `calls in this file`:
//                   the file's functions it calls and how many side-effect lines each has
// Items: id `path:line name`, the function's lines (decorators included) as text, plus the flags' evidence.
// Module-code items: id `path:line (module code)`, at most 60 lines each.

import { inputPaths } from "./step.ts"

const args = Bun.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(name)
  if (at === -1) return undefined
  args.splice(at, 1)
  return true
}
const value = (name: string) => {
  const at = args.indexOf(name)
  if (at === -1) return undefined
  const found = args[at + 1]!
  args.splice(at, 2)
  return found
}
const minLines = Number(value("--min-lines") ?? "1")
const chunk = Number(value("--chunk") ?? "Infinity")
const outer = option("--outer") ?? false
const named = option("--named") ?? false
const moduleCode = option("--module") ?? false
const flags = option("--flags") ?? false
const globals = option("--globals") ?? false
const context = option("--context") ?? false
const docs = option("--docs") ?? false
const hidden = option("--hidden") ?? false
const names = option("--names") ?? false
const effectsOn = option("--effects") ?? false
const minMethods = Number(value("--classes") ?? "Infinity")
const paths = await inputPaths("functions", args)

type Language = "ts" | "py" | "go"
const languageOf = (path: string): Language | undefined =>
  /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path) ? "ts" : path.endsWith(".py") ? "py" : path.endsWith(".go") ? "go" : undefined

const rule = (id: string, language: string, kinds: ReadonlyArray<string>) =>
  `id: ${id}\nlanguage: ${language}\nrule:\n  any: [${kinds.map((kind) => `{kind: ${kind}}`).join(", ")}]`
const tsFunctions = ["function_declaration", "generator_function_declaration", "method_definition", "arrow_function", "function_expression"]
const tsClasses = ["class_declaration", "class"]
const rules = [
  ...["typescript", "tsx", "javascript"].flatMap((language) => [
    rule("function", language, tsFunctions),
    rule("class", language, language === "javascript" ? tsClasses : [...tsClasses, "abstract_class_declaration"])
  ]),
  rule("function", "python", ["function_definition"]),
  rule("class", "python", ["class_definition"]),
  rule("function", "go", ["function_declaration", "method_declaration", "func_literal"])
].join("\n---\n")

interface Match {
  readonly ruleId: "function" | "class"
  readonly file: string
  readonly range: { readonly start: { readonly line: number; readonly column: number }; readonly end: { readonly line: number } }
  readonly text: string
}

const wanted = paths.filter((path) => languageOf(path) !== undefined)
const matches = new Map<string, Array<Match>>()
if (wanted.length > 0) {
  const astGrep = Bun.which("ast-grep") ?? `${import.meta.dir}/../../node_modules/.bin/ast-grep`
  const run = Bun.spawnSync([astGrep, "scan", "--inline-rules", rules, "--json=stream", ...wanted], { stdout: "pipe", stderr: "pipe" })
  if (run.exitCode !== 0) {
    console.error(`functions: ast-grep failed: ${run.stderr.toString()}`)
    process.exit(2)
  }
  for (const line of run.stdout.toString().split("\n")) {
    if (line.trim() === "") continue
    const match = JSON.parse(line) as Match
    matches.set(match.file, [...(matches.get(match.file) ?? []), match])
  }
}

interface Unit {
  readonly start: number
  readonly end: number
  /** Line and column where the function node itself starts (after decorators). */
  readonly nodeLine: number
  readonly nodeColumn: number
  readonly header: string
  readonly name: string | undefined
}

const wrapper = /^\s*(?:describe|suite|context|test\.describe|describe\.\w+)\s*\(/

// A Go function or method name is followed by its parameters (or type parameters); a func literal has none.
const goName = /^func\s*(?:\([^)]*\)\s*)?(\w+)\s*[([]/
const goMethod = /^func\s*\([^)]*\)\s*\w+\s*[([]/

/** The name a function is bound to, from its own header or the code just before it. */
const nameOf = (language: Language, header: string, before: string): string | undefined => {
  if (language === "py") return /def\s+(\w+)/.exec(header)?.[1]
  if (language === "go") return goName.exec(header)?.[1] ?? /(\w+)\s*:?=\s*$/.exec(before.trimEnd())?.[1]
  const declared = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(header)?.[1]
  if (declared !== undefined) return declared
  if (!/^(?:async\s*)?(?:function\b|\(|[\w$]+\s*=>|<)/.test(header)) {
    // A method: modifiers, then the name.
    return /^(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set|declare)\s+|\*\s*)*([\w$#]+|\[[^\]]*\])/.exec(header)?.[1]
  }
  const bound = /(?:(?:const|let|var)\s+([\w$]+)\s*(?::[^=]*)?=|([\w$#]+)\s*[:=]|([\w$]+)\s*\??:\s*[^=]*=)\s*(?:async\s*)?$/.exec(before.trimEnd())
  return bound?.[1] ?? bound?.[2] ?? bound?.[3]
}

/** The text of a parenthesized list starting at `open` in `text` (without the parentheses). */
const group = (text: string, open: number) => {
  let depth = 0
  for (let at = open; at < text.length; at++) {
    const char = text[at]
    if (char === "(" || char === "[" || char === "{") depth++
    if (char === ")" || char === "]" || char === "}") {
      depth--
      if (depth === 0) return { inner: text.slice(open + 1, at), close: at }
    }
  }
  return { inner: text.slice(open + 1), close: text.length }
}

const splitTop = (text: string) => {
  const parts: Array<string> = []
  let depth = 0
  let from = 0
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    if ("([{<".includes(char!)) depth++
    if (")]}>".includes(char!) && text[at - 1] !== "=") depth--
    if (char === "," && depth === 0) {
      parts.push(text.slice(from, at))
      from = at + 1
    }
  }
  parts.push(text.slice(from))
  return parts.map((part) => part.trim()).filter((part) => part !== "")
}

/** The function's boolean parameters, each as `name (positional|keyword-only)`. */
const booleanParameters = (language: Language, header: string): Array<string> => {
  let open = header.indexOf("(")
  if (open === -1) return []
  if (language === "go" && goMethod.test(header)) open = header.indexOf("(", group(header, open).close)
  if (open === -1) return []
  const parameters = splitTop(group(header, open).inner)
  const found: Array<string> = []
  if (language === "go") {
    let pending: Array<string> = []
    for (const parameter of parameters) {
      const [name, ...type] = parameter.split(/\s+/)
      if (type.length === 0) {
        pending.push(name!)
        continue
      }
      if (type.join(" ") === "bool") found.push(...[...pending, name!].map((each) => `${each} (positional)`))
      pending = []
    }
    return found
  }
  let keywordOnly = false
  for (const parameter of parameters) {
    if (language === "py" && /^\*\w*$/.test(parameter)) keywordOnly = true
    if (language === "py" && /^\*\*/.test(parameter)) continue
    const typed = language === "py" ? /^(\w+)\s*:\s*(?:bool|Optional\[bool\]|bool\s*\|\s*None)\s*(?:=|$)/ : /^([\w$]+)\??\s*:\s*boolean\b(?:\s*\|\s*(?:undefined|null))?\s*(?:=|$)/
    const defaulted = language === "py" ? /^(\w+)\s*(?::[^=]*)?=\s*(?:True|False)$/ : /^([\w$]+)\??\s*(?::[^=]*)?=\s*(?:true|false)$/
    const name = typed.exec(parameter)?.[1] ?? defaulted.exec(parameter)?.[1]
    if (name !== undefined) found.push(`${name} (${keywordOnly ? "keyword-only" : "positional"})`)
  }
  return found
}

const trivial = (language: Language, line: string) => {
  const text = line.trim()
  if (text === "" || /^[)\]};,]+;?$/.test(text)) return true
  if (/^(\/\/|\/\*|\*|#)/.test(text)) return true
  if (language === "ts") return /^(import\b|export\s+(\*|\{[^}]*\})\s+from\b|["']use (strict|client|server)["'])/.test(text)
  if (language === "py") return /^(import\s|from\s+\S+\s+import\b|"""|''')/.test(text)
  return /^(package\s|import\s|"[^"]*"$|\w+\s+"[^"]*"$)/.test(text)
}

/** Module-level variable names and their declaration lines. */
const moduleVariables = (language: Language, lines: ReadonlyArray<string>, inUnit: ReadonlyArray<boolean>) => {
  const found = new Map<string, number>()
  let goVarBlock = false
  for (const [index, line] of lines.entries()) {
    if (inUnit[index]) continue
    let names: Array<string> = []
    if (language === "ts") {
      const match = /^(?:export\s+)?(?:declare\s+)?(?:let|var|const)\s+([\w$]+)/.exec(line)
      if (match !== null) names = [match[1]!]
    } else if (language === "py") {
      const match = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(line)
      if (match !== null) names = [match[1]!]
    } else {
      if (/^var\s*\($/.test(line)) goVarBlock = true
      else if (goVarBlock && /^\)/.test(line)) goVarBlock = false
      else if (goVarBlock) names = /^\t(\w+(?:\s*,\s*\w+)*)\b/.exec(line)?.[1]?.split(/\s*,\s*/) ?? []
      else names = /^var\s+(\w+(?:\s*,\s*\w+)*)/.exec(line)?.[1]?.split(/\s*,\s*/) ?? []
    }
    for (const name of names) if (name !== "_" && !found.has(name)) found.set(name, index + 1)
  }
  return found
}

const hiddenKinds: ReadonlyArray<readonly [string, RegExp]> = [
  ["clock", /\b(?:time\.(?:Now|Since|Until|time|monotonic)\(|Date\.now\(|new Date\(\s*\)|datetime\.(?:now|utcnow|today)\(|date\.today\(|performance\.now\()/],
  ["random", /\b(?:Math\.random\(|crypto\.(?:randomUUID|getRandomValues|randomBytes)\(|rand\.[A-Z]\w*\(|random\.\w+\(|uuid\.(?:uuid4|New|NewString|v4)\(|uuidv4\(|secrets\.\w+\()/],
  ["environment", /(?:process\.env\b|\bos\.(?:Getenv|LookupEnv|environ|getenv)\b|\benvknob\.\w+|import\.meta\.env\b|\bBun\.env\b|\bDeno\.env\b)/],
  ["filesystem", /\b(?:fs\.\w+|readFileSync|writeFileSync|os\.(?:ReadFile|WriteFile|Open|OpenFile|Create|Remove|RemoveAll|Rename|MkdirAll|Stat|ReadDir)\(|ioutil\.\w+\(|Path\([^)]*\)\.(?:read|write)_\w+\()|(?<![\w.])open\(/],
  ["constructs a collaborator", /(?:\bnew\s+[A-Z]\w*(?:Client|Store|Service|Session|Repository|Repo|Connection|Pool|Logger|Dialer|Transport|Server|Database|Cache|Queue|Producer|Consumer|Agent)\b|\bboto3\.(?:client|resource|Session)\(|\b(?:requests|httpx)\.(?:get|post|put|patch|delete|request|Session|Client|AsyncClient)\(|\bhttp\.(?:DefaultClient|Get|Post|Head)\b|&?\b\w+\.(?:Client|Dialer|Transport|Server)\{|\bsql\.Open\(|\b(?:redis|kafka|grpc)\.(?:NewClient|Dial|NewReader|NewWriter)\w*\()/]
]

/** The function's lines that reach for a clock, randomness, the environment, the filesystem, or build a client. */
const hiddenDependencies = (lines: ReadonlyArray<string>, start: number, end: number) => {
  const found: Array<string> = []
  for (let line = start; line <= end; line++) {
    const text = lines[line - 1]!
    if (/^\s*(\/\/|#|\*)/.test(text)) continue
    const kinds = hiddenKinds.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind)
    if (kinds.length > 0) found.push(`line ${line} (${kinds.join(", ")}): ${cap(text.trim(), 140)}`)
  }
  return found.length <= 15 ? found.join("\n") : `${found.slice(0, 15).join("\n")}\n(${found.length - 15} more)`
}

const placeholders = new Set(["data", "info", "obj", "object", "item", "tmp", "temp", "res", "resp", "result", "ret", "rv", "val",
  "value", "thing", "stuff", "handle", "process", "manager", "helper", "util", "out", "param", "foo", "bar", "misc", "aux", "dummy"])
const conventional = new Set(["i", "j", "k", "n", "e", "t", "ok", "id", "db", "tx", "w", "r", "wg", "mu", "fn", "cb", "ex", "ip", "os", "io", "fs", "_"])
const words = (name: string) =>
  name.replace(/^[_$#]+|[_$]+$/g, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/_+/).filter((word) => word !== "")
const generic = (language: Language, name: string) => {
  const bare = name.replace(/^[_$#]+/, "")
  if (bare === "" || conventional.has(bare)) return false
  // One- and two-letter names are idiomatic in Go.
  if (bare.length <= 2) return language !== "go"
  const parts = words(name)
  return parts.length <= 2 && parts.some((word) => placeholders.has(word) || placeholders.has(word.replace(/s$/, "")))
}

/** Names a function declares, in its lines: variables, parameters, loop and `as` targets, nested functions. */
const declaredNames = (language: Language, lines: ReadonlyArray<string>, start: number, end: number) => {
  const found = new Map<string, Array<number>>()
  const add = (line: number, list: ReadonlyArray<string>) => {
    for (const raw of list) {
      const name = raw.trim().replace(/^(?:\.\.\.|\*+|readonly\s+|public\s+|private\s+|protected\s+)/, "").split(/[\s:=?,]/)[0]!.replace(/[()[\]{}]/g, "")
      if (!/^[A-Za-z_$#][\w$]*$/.test(name) || ["self", "cls", "this", "const", "let", "var"].includes(name)) continue
      const at = found.get(name) ?? []
      if (!at.includes(line)) at.push(line)
      found.set(name, at)
    }
  }
  for (let line = start; line <= end; line++) {
    const text = lines[line - 1]!
    if (/^\s*(\/\/|#|\*)/.test(text)) continue
    if (language === "ts") {
      for (const match of text.matchAll(/\b(?:const|let|var)\s+([\w$]+)/g)) add(line, [match[1]!])
      for (const match of text.matchAll(/\b(?:const|let|var)\s+[{[]([^}\]]*)[}\]]/g)) add(line, match[1]!.split(",").map((part) => part.split(":").pop()!))
      for (const match of text.matchAll(/\bcatch\s*\(\s*([\w$]+)/g)) add(line, [match[1]!])
      for (const match of text.matchAll(/\bfunction\s*\*?\s*([\w$]*)\s*(?:<[^>]*>)?\s*\(([^()]*)\)/g)) add(line, [match[1]!, ...splitTop(match[2]!)])
      for (const match of text.matchAll(/(?:^|[^\w$.])\(([^()]*)\)\s*(?::\s*[^=;{]+)?=>/g)) add(line, splitTop(match[1]!))
      for (const match of text.matchAll(/(?:^|[^\w$.])([\w$]+)\s*=>/g)) add(line, [match[1]!])
      const method = /^\s*(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([\w$#]+)\s*(?:<[^>]*>)?\s*\(([^()]*)\)\s*(?::[^{]*)?\{\s*$/.exec(text)
      if (method !== null && !["if", "for", "while", "switch", "catch", "return"].includes(method[1]!)) add(line, [method[1]!, ...splitTop(method[2]!)])
    } else if (language === "py") {
      const assigned = /^\s*([A-Za-z_][\w\s,]*?)\s*(?::[^=]*)?=(?!=)/.exec(text)
      if (assigned !== null) add(line, assigned[1]!.split(","))
      for (const match of text.matchAll(/\bfor\s+([\w\s,()]+?)\s+in\b/g)) add(line, match[1]!.split(","))
      for (const match of text.matchAll(/\bas\s+(\w+)/g)) add(line, [match[1]!])
      for (const match of text.matchAll(/\bdef\s+(\w+)\s*\(([^)]*)\)?/g)) add(line, [match[1]!, ...splitTop(match[2]!)])
      for (const match of text.matchAll(/\blambda\s+([\w\s,*=]+):/g)) add(line, match[1]!.split(","))
      // A parameter on its own line of a multi-line `def`.
      if (/^\s+[\w*]+\s*(?::[^=,]*)?(?:=[^,]*)?,?\s*$/.test(text) && /\bdef\b[^:]*$/.test(lines.slice(Math.max(start - 1, line - 6), line - 1).join(" "))) add(line, [text])
    } else {
      for (const match of text.matchAll(/(?:^|[\s(;])((?:\w+\s*,\s*)*\w+)\s*:=/g)) add(line, match[1]!.split(","))
      for (const match of text.matchAll(/\bvar\s+(\w+)/g)) add(line, [match[1]!])
      for (const match of text.matchAll(/\bfunc\s*(?:\([^)]*\)\s*)?(\w*)\s*\(([^)]*)\)/g)) add(line, [match[1]!, ...splitTop(match[2]!)])
    }
  }
  return found
}

const genericNames = (language: Language, lines: ReadonlyArray<string>, start: number, end: number) =>
  [...declaredNames(language, lines, start, end)].filter(([name]) => generic(language, name)).slice(0, 15)
    .map(([name, at]) => `${name} (line${at.length > 1 ? "s" : ""} ${at.slice(0, 5).join(", ")}${at.length > 5 ? ", …" : ""})`).join(", ")

const effectCall = /\.(?:delete|pop|push|shift|unshift|splice|set|setdefault|add|clear|remove|append|extend|insert|update|put|write|save|send|emit|dispatch|publish|enqueue|close|reset|stop|start|kill|exec|execute|commit|rollback|flush|create|destroy|drop|rename|unlink|mkdir|post|patch|upload|store|persist|record|register|unregister|subscribe|notify|invalidate|evict|Set|Add|Delete|Remove|Put|Write|Store|Send|Close|Reset|Exec|Update|Create|Inc|Observe)(?:[A-Z_]\w*)?\(/g
const effectIO = /(?:\bos\.(?:WriteFile|Remove|RemoveAll|Rename|Exit|Setenv|MkdirAll|Create)\(|\bfetch\(|\bexec\.Command\(|\bsubprocess\.|\bdel\s|(?<![\w.])delete\(|\bsetattr\(|\bglobal\s|\bnonlocal\s|[\w\])]\s*<-\s*[^\s-])/

const queryVerbs = new Set(["get", "is", "has", "find", "compute", "calc", "calculate", "validate", "check", "lookup", "count", "list", "can", "should"])

/** The function's lines that change state outside its locals or perform I/O. */
const effects = (language: Language, header: string, lines: ReadonlyArray<string>, start: number, end: number) => {
  const receiver = language === "go" ? (goMethod.test(header) ? /^func\s*\(\s*(\w+)/.exec(header)?.[1] : undefined) : language === "py" ? "self|cls" : "this"
  const field = receiver === undefined ? undefined : new RegExp(`(?<![\\w.])(?:${receiver})(?:\\.[\\w$#]+|\\[[^\\]]+\\])+\\s*(?:[-+*/|&]?=(?!=)|\\+\\+|--)`)
  // Mutating a variable the function itself created is not a side effect.
  const locals = new Set(declaredNames(language, lines, start + 1, end).keys())
  const mutates = (text: string) =>
    [...text.matchAll(effectCall)].some((match) => {
      const base = /([\w$]+)[\w$.?[\]'"]*$/.exec(text.slice(0, match.index))?.[1]
      return base === undefined || !locals.has(base)
    })
  const found: Array<string> = []
  for (let line = start; line <= end; line++) {
    const text = lines[line - 1]!
    if (/^\s*(\/\/|#|\*)/.test(text)) continue
    const kinds = [
      ...(field?.test(text) ? ["changes state"] : []),
      ...(mutates(text) ? ["mutating or I/O call"] : []),
      ...(effectIO.test(text) ? ["I/O"] : [])
    ]
    if (kinds.length > 0) found.push(`line ${line} (${kinds.join(", ")}): ${cap(text.trim(), 120)}`)
  }
  return found.length <= 20 ? found.join("\n") : `${found.slice(0, 20).join("\n")}\n(${found.length - 20} more)`
}

const escape = (name: string) => name.replace(/[$]/g, "\\$")
const cap = (text: string, length: number) => (text.length > length ? `${text.slice(0, length)}…` : text)

const out: Array<string> = []
for (const path of wanted) {
  const language = languageOf(path)!
  const source = await Bun.file(path).text()
  const lines = source.split("\n")
  const found = matches.get(path) ?? []
  const classes = found.filter((match) => match.ruleId === "class").map((match) => ({
    start: match.range.start.line + 1,
    end: match.range.end.line + 1,
    name: /class\s+([\w$]+)/.exec(match.text)?.[1] ?? "(anonymous class)"
  }))
  const all: Array<Unit> = found.filter((match) => match.ruleId === "function").map((match) => {
    const nodeLine = match.range.start.line + 1
    let start = nodeLine
    while (start > 1 && /^\s*@/.test(lines[start - 2]!)) start--
    if (docs) while (start > 1 && /^\s*(\/\/|\/\*|\*|#)/.test(lines[start - 2]!)) start--
    const header = match.text.slice(0, 600)
    const before = lines[nodeLine - 1]!.slice(0, match.range.start.column)
    const name = nameOf(language, header, before)
    return {
      start,
      end: match.range.end.line + 1,
      nodeLine,
      nodeColumn: match.range.start.column,
      header,
      name
    }
  })
  const transparent = (unit: Unit) => unit.name === undefined && wrapper.test(lines[unit.nodeLine - 1]!)
  const contains = (a: Unit, b: Unit) => a !== b && a.start <= b.start && b.end <= a.end && (a.start < b.start || a.end > b.end || a.nodeColumn < b.nodeColumn)
  const units = all.filter((unit) => !transparent(unit))
  const inUnit = lines.map((_, index) => units.some((unit) => unit.start <= index + 1 && index + 1 <= unit.end))
  const variables = globals ? moduleVariables(language, lines, inUnit) : new Map<string, number>()
  const positionalFlag = (unit: Unit) => booleanParameters(language, unit.header).some((each) => each.endsWith("(positional)"))
  const flagged = flags ? units.filter(positionalFlag) : []
  const effectLines = new Map<string, number>()
  if (effectsOn) {
    for (const unit of units) {
      if (unit.name === undefined) continue
      const count = effects(language, unit.header, lines, unit.nodeLine, unit.end).split("\n").filter((line) => line.startsWith("line ")).length
      effectLines.set(unit.name, Math.max(effectLines.get(unit.name) ?? 0, count))
    }
  }
  for (const unit of units) {
    if (outer && units.some((other) => contains(other, unit))) continue
    if (named && unit.name === undefined) continue
    if (unit.end - unit.nodeLine + 1 < minLines) continue
    const evidence: Array<[string, string]> = []
    if (context) {
      const parent = units.filter((other) => contains(other, unit)).sort((a, b) => b.start - a.start)[0]
      const owner = classes.filter((each) => each.start <= unit.start && unit.end <= each.end).sort((a, b) => b.start - a.start)[0]
      if (parent !== undefined && (owner === undefined || owner.start < parent.start)) {
        evidence.push(["defined in", `function ${parent.name ?? "(anonymous)"} (line ${parent.nodeLine})`])
      } else if (owner !== undefined) evidence.push(["defined in", `class ${owner.name} (line ${owner.start})`])
    }
    if (flags) {
      // The rule allows a keyword-only boolean, so only a positional one makes a candidate.
      if (!flagged.includes(unit)) continue
      const booleans = booleanParameters(language, unit.header)
      evidence.push(["boolean parameters", booleans.join(", ")])
      if (unit.name !== undefined) {
        const call = new RegExp(`(?<![\\w$])${escape(unit.name)}\\s*(?:<[^>()]*>)?\\(`)
        const isCall = (line: string) => call.test(line) && !/^\s*(def|func|function)\b/.test(line)
        const sites = lines.flatMap((line, index) =>
          (index + 1 < unit.start || index + 1 > unit.nodeLine) && isCall(line) ? [`line ${index + 1}: ${cap(line.trim(), 160)}`] : [])
        evidence.push(["call sites", sites.length === 0 ? "none in this file" : sites.slice(0, 8).join("\n") + (sites.length > 8 ? `\n(${sites.length - 8} more)` : "")])
        // A call that passes a bare boolean, outside every function judged here, is its own item: the rule's
        // `render(doc, true)`. Calls inside a judged function are already part of its item.
        for (const [index, line] of lines.entries()) {
          if (flagged.some((each) => each.start <= index + 1 && index + 1 <= each.end)) continue
          if (!isCall(line) || !/(?<![\w$.])(?:true|false|True|False)(?![\w$])/.test(line)) continue
          out.push(JSON.stringify({
            id: `${path}:${index + 1} call of ${unit.name}`,
            path,
            lines: [index + 1, index + 1],
            "called function": `${cap(lines[unit.nodeLine - 1]!.trim(), 200)} (line ${unit.nodeLine})`,
            "boolean parameters": booleans.join(", "),
            text: line.trim()
          }))
        }
      }
    }
    if (globals) {
      const body = lines.slice(unit.start - 1, unit.end).join("\n")
      const used = [...variables].filter(([name]) => new RegExp(`(?<![\\w$.])${escape(name)}(?![\\w$])`).test(body))
      evidence.push(["module-level variables used", used.length === 0 ? "none" : used.map(([name, line]) => `${name} (line ${line}: ${cap(lines[line - 1]!.trim(), 140)})`).join("\n")])
    }
    if (hidden) evidence.push(["hidden dependencies", hiddenDependencies(lines, unit.nodeLine, unit.end)])
    if (names) evidence.push(["generic or short names declared", genericNames(language, lines, unit.nodeLine, unit.end)])
    if (effectsOn) {
      const verb = words(unit.name ?? "")[0]
      if (verb !== undefined && queryVerbs.has(verb)) evidence.push(["name reads as", `a query (${verb}…)`])
      evidence.push(["side effects", effects(language, unit.header, lines, unit.nodeLine, unit.end)])
      const body = lines.slice(unit.nodeLine, unit.end).join("\n")
      const called = [...effectLines].filter(([name]) => name !== unit.name && new RegExp(`(?<![\\w$])${escape(name)}\\s*\\(`).test(body))
      evidence.push(["calls in this file", called.slice(0, 10).map(([name, count]) =>
        `${name} (${count === 0 ? "no side effects found" : `${count} side-effect line${count === 1 ? "" : "s"}`})`).join(", ")])
    }
    const total = unit.end - unit.start + 1
    if (total <= chunk) {
      out.push(JSON.stringify({
        id: `${path}:${unit.nodeLine} ${unit.name ?? "(anonymous)"}`,
        path,
        lines: [unit.start, unit.end],
        text: lines.slice(unit.start - 1, unit.end).join("\n"),
        ...Object.fromEntries(evidence)
      }))
      continue
    }
    const parts = Math.ceil(total / chunk)
    const size = Math.ceil(total / parts)
    for (let part = 0; part < parts; part++) {
      const from = unit.start + part * size
      const to = Math.min(unit.end, from + size - 1)
      const own = evidence.map(([name, text]): [string, string] =>
        name === "generic or short names declared" ? [name, genericNames(language, lines, from, to)]
        : name === "hidden dependencies" ? [name, hiddenDependencies(lines, from, to)]
        : [name, text])
      out.push(JSON.stringify({
        id: `${path}:${from} ${unit.name ?? "(anonymous)"} (part ${part + 1} of ${parts})`,
        path,
        lines: [from, to],
        function: `${cap(lines[unit.nodeLine - 1]!.trim(), 160)} (lines ${unit.start}-${unit.end}; this item is lines ${from}-${to} of it)`,
        ...Object.fromEntries(own),
        text: lines.slice(from - 1, to).join("\n")
      }))
    }
  }
  for (const owner of classes) {
    const members = units.filter((unit) =>
      owner.start < unit.start && unit.end <= owner.end &&
      !units.some((other) => other !== unit && owner.start < other.start && contains(other, unit)) &&
      !classes.some((inner) => inner !== owner && owner.start < inner.start && inner.start <= unit.start && unit.end <= inner.end))
    if (members.length < minMethods) continue
    const shown = lines.flatMap((text, index) => {
      const line = index + 1
      if (line < owner.start || line > owner.end || trivial(language, text)) return []
      const member = members.find((unit) => unit.start <= line && line <= unit.end)
      if (member !== undefined && line !== member.nodeLine) return []
      if (member === undefined && units.some((unit) => unit.start <= line && line <= unit.end)) return []
      return [`${line}: ${cap(text, 160)}`]
    })
    out.push(JSON.stringify({
      id: `${path}:${owner.start} class ${owner.name}`,
      path,
      lines: [owner.start, owner.end],
      text: shown.length <= 120 ? shown.join("\n") : `${shown.slice(0, 120).join("\n")}\n(${shown.length - 120} more lines)`
    }))
  }
  if (moduleCode) {
    const maxRun = 60
    let run: Array<number> = []
    const flush = () => {
      while (run.length > 0 && trivial(language, lines[run[run.length - 1]! - 1]!)) run.pop()
      while (run.length > 0 && trivial(language, lines[run[0]! - 1]!)) run.shift()
      if (run.length > 0) {
        const [first, last] = [run[0]!, run[run.length - 1]!]
        out.push(JSON.stringify({ id: `${path}:${first} (module code)`, path, lines: [first, last], text: lines.slice(first - 1, last).join("\n") }))
      }
      run = []
    }
    for (let line = 1; line <= lines.length; line++) {
      if (inUnit[line - 1]) flush()
      else {
        run.push(line)
        if (run.length >= maxRun) flush()
      }
    }
    flush()
  }
}
if (out.length > 0) await new Promise<void>((resolve) => process.stdout.write(`${out.join("\n")}\n`, () => resolve()))

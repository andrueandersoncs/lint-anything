// Eval selector: `bun "$EVAL_STEPS/errors.ts"` emits every error handler in the TypeScript, JavaScript,
// Python, and Go files whose paths it reads on stdin: `catch` clauses and `.catch(…)`-style handler calls, `except`
// clauses and `suppress(…)` blocks, Go `if` blocks that test an error (or `recover()`), and Go
// `fmt.Errorf` / `errors.New` / `log.Fatal…` calls outside those blocks. A Go block that only returns the
// error unchanged (`return nil, err`) handles nothing and is left out. Each item is the handler (at most
// 25 lines); evidence: the code whose error it handles (`handles`, at most 12 lines: the `try` body, the
// statement before an `if err != nil`, or the expression `.catch` is called on) and the line that opens
// the enclosing function (`function`).
import { $ } from "bun"
import { inputPaths } from "./step.ts"

const handlerProperty = "^(catch|catchAll|catchTag|catchTags|catchAllCause|catchError|mapError|orElse|tapError)$"
const script = (language: string) => `
id: handler
language: ${language}
rule:
  any:
    - kind: catch_clause
    - kind: call_expression
      has: { field: function, kind: member_expression, has: { field: property, regex: "${handlerProperty}" } }
---
id: try
language: ${language}
rule: { kind: try_statement }
`
const rules = [
  script("typescript"),
  script("tsx"),
  script("javascript"),
  `
id: handler
language: python
rule:
  any:
    - kind: except_clause
    - kind: with_statement
      has: { kind: with_clause, regex: "\\\\bsuppress\\\\(" }
---
id: try
language: python
rule: { kind: try_statement }
`,
  `
id: handler
language: go
rule:
  any:
    - kind: if_statement
      any:
        - has: { field: condition, regex: "(?i)err" }
        - has: { field: initializer, regex: "(?i)err|recover\\\\(\\\\)" }
    - kind: expression_case
      has: { field: value, regex: "(?i)err" }
    - kind: return_statement
      regex: "(?i)err\\\\w*\\\\s*[!=]=\\\\s*nil"
---
id: construct
language: go
rule:
  kind: call_expression
  has: { field: function, regex: "^(fmt\\\\.Errorf|errors\\\\.(New|Wrap|Wrapf)|log\\\\.(Fatal|Fatalf|Fatalln|Panic|Panicf))$" }
`
].join("\n---\n")

interface Match {
  readonly file: string
  readonly ruleId: string
  readonly text: string
  readonly range: { readonly start: { readonly line: number }; readonly end: { readonly line: number } }
}

const maxItem = 25
const maxHandles = 12
// A line that opens a function: a declaration, a method, or an arrow function.
const opensFunction = /\b(function|def|func)\b|=>\s*\{?\s*$|^\s*(async\s+)?(static\s+)?(public\s+|private\s+|protected\s+)?\*?\w+\s*\([^)]*\)\s*(:\s*[^={]+)?\{\s*$/
const indent = (line: string) => line.length - line.trimStart().length
// A Go block that only propagates the error: `if err != nil { return [zero values,] err }`.
const propagates = /^\s*if [^{]*\{\s*\n\s*return\s+(?:(?:nil|""|0|false|\w+\{\}|\w+),\s*)*err\s*\n\s*\}\s*$/

const numbered = (lines: ReadonlyArray<string>, from: number, to: number) =>
  lines.slice(from - 1, to).map((line, index) => `${from + index}: ${line}`).join("\n")
const capped = (lines: ReadonlyArray<string>, from: number, to: number, max: number) =>
  to - from + 1 > max ? `${numbered(lines, from, from + max - 1)}\n…` : numbered(lines, from, to)

const functionOf = (lines: ReadonlyArray<string>, start: number) => {
  const own = indent(lines[start - 1] ?? "")
  for (let at = start - 1; at >= 1; at--) {
    const line = lines[at - 1]!
    if (line.trim() !== "" && indent(line) < own && opensFunction.test(line)) return `${at}: ${line.trim()}`
  }
  return ""
}

// The statement just above `start` (back to the previous blank line or block boundary, at most 12 lines).
const previousStatement = (lines: ReadonlyArray<string>, start: number) => {
  let from = start - 1
  while (from > 1 && start - from < maxHandles) {
    const above = lines[from - 2]!
    if (above.trim() === "" || /[{}]\s*$/.test(above) || indent(above) < indent(lines[start - 1]!)) break
    from--
  }
  return from >= 1 && from < start && lines[from - 1]!.trim() !== "" ? numbered(lines, from, start - 1) : ""
}

const strings = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g
const mentions = (code: string, name: string) => new RegExp(`(?<![\\w.])${name}\\b`).test(code.replace(strings, ""))
const logs = /\b(console|log|logger|logging|klog|slog|zap|zerolog|print)\w*\s*[.(]|\.(Error|Errorf|Warn|Warnf|Warning|Info|Infof|Debug|Debugf|Msg|Msgf|Print|Printf|Println|error|warn|warning|info|debug|exception|critical)\(/
// Lines from `at` until the parentheses opened on it close (at most 5), joined.
const statementAt = (lines: ReadonlyArray<string>, at: number, end: number) => {
  let text = ""
  let depth = 0
  for (let i = at; i <= Math.min(end, at + 4); i++) {
    const line = lines[i - 1]!.replace(strings, "\"\"")
    text += `${lines[i - 1]!.trim()} `
    depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length
    if (depth <= 0) break
  }
  return text
}

// The handled error's name: the catch or except binding, the `.catch` callback's parameter, or the Go
// error variable the condition tests.
const errorName = (header: string, language: "go" | "py" | "js") => {
  if (language === "py") return /\bexcept\b.*\bas\s+(\w+)/.exec(header)?.[1]
  if (language === "js") return /\bcatch\s*\(\s*(\w+)/.exec(header)?.[1] ?? /\.\w+\(\s*(?:async\s+)?\(?\s*(\w+)\s*(?:[:,)]|=>)/.exec(header)?.[1]
  return /(?<![\w.])([A-Za-z]*[Ee]rr\w*)\b/.exec(header.replace(strings, "").replace(/\berrors\./g, ""))?.[1]
}

/** Computed facts about what lines `start`-`end` do with the error they handle. */
const factsOf = (lines: ReadonlyArray<string>, start: number, end: number, language: "go" | "py" | "js") => {
  const header = language === "go" ? lines[start - 1]! : statementAt(lines, start, end)
  const name = errorName(header, language)
  const facts: Array<string> = []
  if (name === undefined) {
    if (language !== "go" && !/\braise\s*$/m.test(lines.slice(start - 1, end).join("\n"))) {
      facts.push(language === "py" ? "The clause binds no name for the exception." : "The handler binds no name for the error.")
    }
  } else {
    const body = lines.slice(start, end).join("\n")
    if (!mentions(body, name)) facts.push(`\`${name}\` is not used in the handler's body.`)
  }
  const label = name === undefined ? "the error" : `\`${name}\``
  for (let at = start; at <= end; at++) {
    const line = lines[at - 1]!
    const code = line.replace(strings, "\"\"")
    if (/^\s*(\/\/|#)/.test(line)) continue
    const statement = statementAt(lines, at, end)
    const uses = name !== undefined && mentions(statement, name)
    if (language === "go" && /\bfmt\.Errorf\(/.test(code)) {
      const format = /fmt\.Errorf\(\s*("(?:[^"\\]|\\.)*"|`[^`]*`)/.exec(statement)?.[1] ?? ""
      if (/%w/.test(format)) facts.push(`Line ${at}: fmt.Errorf wraps an error with %w.`)
      else if (uses && /\.Error\(\)/.test(statement)) facts.push(`Line ${at}: fmt.Errorf turns ${label} into a string with .Error() and has no %w, so the new error does not wrap it.`)
      else if (uses) facts.push(`Line ${at}: fmt.Errorf formats ${label} without %w, so the new error does not wrap it.`)
      else facts.push(`Line ${at}: fmt.Errorf builds a new error without ${label}.`)
    } else if (language === "go" && /\berrors\.New\(/.test(code)) {
      facts.push(`Line ${at}: errors.New builds a new error${uses ? ` from ${label}'s text, which does not wrap it` : ` without ${label}`}.`)
    } else if (language === "js" && /\bthrow\b/.test(code)) {
      if (name !== undefined && new RegExp(`\\bthrow\\s+${name}\\b`).test(code)) facts.push(`Line ${at}: rethrows ${label}.`)
      else if (/\bcause\b/.test(statement)) facts.push(`Line ${at}: throws a new error with a \`cause\`.`)
      else facts.push(`Line ${at}: throws a new error ${uses ? `built from ${label} but without \`cause\`` : `without ${label}`}.`)
    } else if (language === "py" && /^\s*raise\b/.test(code)) {
      if (/^\s*raise\s*$/.test(code)) facts.push(`Line ${at}: re-raises the original exception.`)
      else if (/\bfrom\s+None\b/.test(code)) facts.push(`Line ${at}: raises a new exception \`from None\`, suppressing the original.`)
      else if (/\bfrom\s+\w+/.test(statement)) facts.push(`Line ${at}: raises a new exception chained with \`from\`.`)
      else if (name !== undefined && new RegExp(`^\\s*raise\\s+${name}\\s*$`).test(code)) facts.push(`Line ${at}: re-raises ${label}.`)
      else facts.push(`Line ${at}: raises a new exception without \`from\`; Python keeps the original as its implicit context (\`__context__\`).`)
    } else if (logs.test(code)) {
      if (!uses && !/\.exception\(|exc_info|\.Err\(/.test(statement)) facts.push(`Line ${at}: logs without ${label}.`)
    } else if (/^\s*return\b/.test(code) && !uses && at > start) {
      facts.push(`Line ${at}: returns without ${label}.`)
    } else if (/^\s*pass\s*$/.test(code)) {
      facts.push(`Line ${at}: \`pass\` discards ${label}.`)
    }
  }
  return facts.join("\n")
}

const files = new Map<string, ReadonlyArray<string>>()
const linesOf = async (path: string) => {
  if (!files.has(path)) files.set(path, (await Bun.file(path).text()).split("\n"))
  return files.get(path)!
}

const paths = await inputPaths("errors", Bun.argv.slice(2))
const out: Array<string> = []
if (paths.length > 0) {
  const run = await $`ast-grep scan --inline-rules ${rules} --json=stream ${paths}`.nothrow().quiet()
  if (run.exitCode !== 0) {
    console.error(`errors: ast-grep failed: ${run.stderr.toString()}`)
    process.exit(2)
  }
  const stream = run.stdout.toString()
  const matches = stream.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Match)
  const span = (match: Match) => [match.range.start.line + 1, match.range.end.line + 1] as const
  const tries = matches.filter((match) => match.ruleId === "try")
  const handlers = matches.filter((match) => match.ruleId === "handler")
  const within = (inner: Match, outer: Match) =>
    inner.file === outer.file && span(outer)[0] <= span(inner)[0] && span(inner)[1] <= span(outer)[1]
  const seen = new Set<string>()
  for (const match of matches) {
    if (match.ruleId === "try") continue
    if (match.ruleId === "construct" && handlers.some((handler) => handler !== match && within(match, handler))) continue
    // A Go error built from nothing but literals and non-error values converts no error.
    if (match.ruleId === "construct" && !/\b[Ee]rr\w*|\w*Err\b/.test(match.text.replace(/^[\w.]+\(/, "").replace(strings, ""))) continue
    if (match.file.endsWith(".go") && match.ruleId === "handler" && propagates.test(match.text)) continue
    // `if err == nil { … }` with no else is the success path, not a handler.
    if (/^if [^{]*\b\w*[Ee]rr\w*\s*==\s*nil\s*\{/.test(match.text) && !/!=/.test(match.text.split("{")[0]!) && !/\}\s*else\b/.test(match.text)) continue
    const lines = await linesOf(match.file)
    let [start, end] = span(match)
    let handles = ""
    if (/^(catch|except)\b/.test(match.text)) {
      // The innermost `try` holding this clause; its body runs from the `try` to the first clause.
      const owner = tries.filter((t) => within(match, t)).sort((a, b) => span(b)[0] - span(a)[0])[0]
      if (owner !== undefined) {
        const first = Math.min(...handlers.filter((h) => within(h, owner) && /^(catch|except)\b/.test(h.text) &&
          indent(lines[span(h)[0] - 1]!) <= indent(lines[span(match)[0] - 1]!)).map((h) => span(h)[0]))
        handles = capped(lines, span(owner)[0], first - 1, maxHandles)
      }
    } else if (match.file.endsWith(".go")) {
      if (match.ruleId === "handler" && !/^if [^{]*;/.test(match.text)) handles = previousStatement(lines, start)
    } else if (!match.text.startsWith("with")) {
      // `x.catch(…)`: the handler starts at the `.catch` line; the expression before it is what it handles.
      const at = lines.findIndex((line, index) => index + 1 >= start && index + 1 <= end &&
        new RegExp(`\\.(${handlerProperty.slice(2, -2)})\\b`).test(line))
      if (at !== -1 && at + 1 > start) {
        handles = capped(lines, Math.max(start, at + 1 - maxHandles), at, maxHandles)
        start = at + 1
      }
    }
    const key = `${match.file}:${start}`
    if (seen.has(key)) continue
    seen.add(key)
    const text = end - start + 1 > maxItem
      ? `${lines.slice(start - 1, start - 1 + maxItem).join("\n")}\n…`
      : lines.slice(start - 1, end).join("\n")
    end = Math.min(end, start + maxItem - 1)
    const language = match.file.endsWith(".go") ? "go" : match.file.endsWith(".py") ? "py" : "js"
    out.push(JSON.stringify({
      id: key,
      path: match.file,
      lines: [start, end],
      text,
      handles,
      function: functionOf(lines, start),
      facts: factsOf(lines, start, end, language)
    }))
  }
}
if (out.length > 0) await new Promise<void>((resolve) => process.stdout.write(`${out.join("\n")}\n`, () => resolve()))

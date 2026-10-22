// Eval selector: `bun "$EVAL_STEPS/errors-go.ts" "$@"` emits, for each Go file given, every statement that
// could drop a returned error: a call used as a bare statement, a `defer` or `go` call, and an assignment
// that puts a call's result into `_`. Calls that return nothing an error could hide in are left out (the
// fmt print family, builtins, testing.T reporting, sync locking). Evidence, when the file shows it: the
// callee's signature if the file declares exactly one of that name (`declared`), which result `_` takes
// (`blank`), and the line that set the call's receiver (`receiver`).
import { $ } from "bun"

const rule = `
id: dropped
language: go
rule:
  any:
    - kind: expression_statement
      has: { kind: call_expression, stopBy: neighbor }
    - kind: defer_statement
    - kind: go_statement
    - any: [ { kind: assignment_statement }, { kind: short_var_declaration }, { kind: var_spec } ]
      all:
        - has: { has: { kind: identifier, regex: "^_$" }, stopBy: neighbor }
        - has: { kind: expression_list, stopBy: neighbor, has: { kind: call_expression, stopBy: neighbor } }
`

interface Match {
  readonly file: string
  readonly text: string
  readonly range: { readonly start: { readonly line: number }; readonly end: { readonly line: number } }
}

// Calls that return no error, or whose error the rule exempts.
const exempt = [
  /^fmt\.(Print|Printf|Println|Fprint|Fprintf|Fprintln)\(/,
  /^(panic|close|delete|print|println|clear|copy|recover)\(/,
  /^(t|b|tb|f)\.(Helper|Parallel|Fatal|Fatalf|Error|Errorf|Log|Logf|Skip|Skipf|SkipNow|Fail|FailNow|Cleanup|Setenv|Chdir|Run)\(/,
  /^[\w.]+\.(Lock|Unlock|RLock|RUnlock|Done)\(\)$/,
  /^(cancel|wg\.Add)\b/,
  // testify: assert functions return a bool, require functions nothing.
  /^(assert|require)\.\w+\(/
]
const maxLines = 4

const files = new Map<string, ReadonlyArray<string>>()
const linesOf = async (path: string) => {
  if (!files.has(path)) files.set(path, (await Bun.file(path).text()).split("\n"))
  return files.get(path)!
}

// The call a statement makes: what follows `defer`/`go`/`=`.
const callOf = (flat: string) => /^(?:defer|go) (.*)$/.exec(flat)?.[1] ?? /^(?:var )?[^=(]*?:?= (.*)$/.exec(flat)?.[1] ?? flat

// The results part of a function signature whose parameter list opens at `open`, or undefined.
const resultsOf = (signature: string, open: number) => {
  let depth = 0
  for (let i = open; i < signature.length; i++) {
    if (signature[i] === "(") depth++
    if (signature[i] === ")" && --depth === 0) return signature.slice(i + 1).replace(/\{\s*$/, "").trim()
  }
  return undefined
}

// The callee's signature when this file declares exactly one function or local closure (for a plain
// call) or one method (for a call on a receiver) of that name, and whether its results include an error.
const declaredOf = (lines: ReadonlyArray<string>, name: string, method: boolean) => {
  const pattern = new RegExp(method ? `^func \\([^)]*\\) ${name}(?:\\[[^\\]]*\\])?\\(` : `^func ${name}(?:\\[[^\\]]*\\])?\\(|^\\s*${name}\\s*:?=\\s*func\\s*\\(`)
  const found = lines.flatMap((line, at) => (pattern.test(line) ? [at] : []))
  if (found.length !== 1) return ""
  const at = found[0]!
  const signature: Array<string> = []
  for (let i = at; i < lines.length && signature.length < 8; i++) {
    signature.push(lines[i]!.trim())
    if (/\{\s*$/.test(lines[i]!)) break
  }
  const text = signature.join(" ")
  const head = pattern.exec(text)
  const results = head === null ? undefined : resultsOf(text, head.index + head[0].length - 1)
  if (results === undefined) return ""
  const returns = /\berror\b/.test(results) ? "its results include an error" : "it returns no error"
  return `line ${at + 1}: \`${text.replace(/\s*\{\s*$/, "")}\` (${returns})`
}

// Which result `_` takes in `a, _ := f()`, and where the last result goes; undefined when the last result
// goes to an error variable (`_, err := f()`), which keeps the error.
const blankOf = (flat: string) => {
  const left = /^(?:var )?(.*?)\s*:?=\s/.exec(flat)?.[1]
  if (left === undefined || !/^[\w.,\s[\]*]+$/.test(left) || /^(defer|go)\b/.test(flat)) return ""
  const names = left.split(",").map((name) => name.trim())
  const blanks = names.flatMap((name, index) => (name === "_" ? [index + 1] : []))
  if (blanks.length === 0) return ""
  const last = names[names.length - 1]!
  if (/^[A-Za-z]*[Ee]rr\w*$/.test(last)) return undefined
  const which = `\`_\` takes result ${blanks.join(" and ")} of ${names.length}`
  return last === "_" ? `${which}, including the last (where a Go function returns its error, if it has one)` : `${which}; the last result goes to \`${last}\``
}

// How the line that set a receiver opened it, when it visibly opened a file.
const openedBy = (line: string) => {
  if (/\bos\.Open\(/.test(line)) return " (os.Open opens a file only for reading)"
  if (/\bos\.Create\(/.test(line)) return " (os.Create opens a file for writing)"
  if (/\bos\.OpenFile\(/.test(line)) {
    if (/O_(WRONLY|RDWR|APPEND|CREATE|TRUNC)/.test(line)) return " (os.OpenFile with write flags opens a file for writing)"
    return /O_RDONLY/.test(line) ? " (os.OpenFile with O_RDONLY opens a file only for reading)" : ""
  }
  return ""
}

// The nearest line above `start`, within the enclosing function, that declares or assigns `name`.
const receiverOf = (lines: ReadonlyArray<string>, start: number, name: string) => {
  const sets = new RegExp(`(?:^|[\\s,(])${name}(?:\\s*,\\s*[\\w.]+)*\\s*:?=[^=]|\\bvar ${name}\\b`)
  for (let at = start - 1; at >= 1; at--) {
    const line = lines[at - 1]!
    if (sets.test(line)) return `\`${name}\` set at line ${at}: ${line.trim()}${openedBy(line)}`
    if (/^func /.test(line)) break
  }
  return ""
}

const paths = Bun.argv.slice(2)
const out: Array<string> = []
if (paths.length > 0) {
  const run = await $`ast-grep scan --inline-rules ${rule} --json=stream ${paths}`.nothrow().quiet()
  if (run.exitCode !== 0) {
    console.error(`errors-go: ast-grep failed: ${run.stderr.toString()}`)
    process.exit(2)
  }
  const stream = run.stdout.toString()
  const seen = new Set<string>()
  for (const line of stream.split("\n")) {
    if (line.trim() === "") continue
    const match = JSON.parse(line) as Match
    const flat = match.text.replace(/\s+/g, " ").trim()
    const call = callOf(flat)
    // A deferred or spawned function literal: its own statements are items.
    if (/^func\s*\(/.test(call)) continue
    if (exempt.some((pattern) => pattern.test(call))) continue
    const blank = blankOf(flat)
    if (blank === undefined) continue
    const lines = await linesOf(match.file)
    const start = match.range.start.line + 1
    const end = Math.min(match.range.end.line + 1, start + maxLines - 1)
    const key = `${match.file}:${start}`
    if (seen.has(key)) continue
    seen.add(key)
    const text = lines.slice(start - 1, end).join("\n") + (end < match.range.end.line + 1 ? "\n…" : "")
    // `a.b().c(` → receiver `a`, callee `c`.
    const callee = /^([\w.]*?)(\w+)\s*(?:\[[^\]]*\])?\(/.exec(call.replace(/\([^()]*\)\./g, "."))
    const receiver = callee?.[1]?.split(".")[0] ?? ""
    out.push(JSON.stringify({
      id: key,
      path: match.file,
      lines: [start, end],
      text,
      declared: callee ? declaredOf(lines, callee[2]!, callee[1] !== "") : "",
      blank,
      receiver: receiver === "" ? "" : receiverOf(lines, start, receiver)
    }))
  }
}
if (out.length > 0) await new Promise<void>((resolve) => process.stdout.write(`${out.join("\n")}\n`, () => resolve()))

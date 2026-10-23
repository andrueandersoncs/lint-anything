// Eval selector: `bun "$EVAL_STEPS/tests.ts" <names|behavior>` emits the tests in the test files whose paths it reads on stdin as items
// (JSONL), found with ast-grep: TypeScript/JavaScript `it`/`test` calls and `describe` blocks, Python `test…`
// functions and methods (unittest classes included), Go `Test…` functions and `t.Run` subtests.
//   names:    one item per test, subtest, and describe block whose name is written out: the name, with its
//             kind, enclosing suites, subtests (Go table tests: the table's case names), and assertions as
//             evidence.
//   behavior: one item per test, subtest, helper, fixture, hook, describe block, and function that declares
//             tests with code of its own: the full code, with the private members it touches, what it mocks or
//             patches, and its assertions on calls (for blocks: in their own code) as evidence.
// These are eval helpers, not part of the CLI.

import { resolve } from "node:path"
import { inputPaths } from "./step.ts"

// suite: a describe block or test class; wrapper: a function that declares tests (`function suite() { describe(…) }`).
type Kind = "test" | "subtest" | "suite" | "wrapper" | "helper"
interface Unit {
  readonly kind: Kind
  readonly name: string
  readonly literal: boolean // the name is written in the code, not computed (`t.Run(tt.name, …)`)
  readonly start: number // 1-based, inclusive, decorators included
  readonly end: number
  readonly bytes: readonly [number, number] // for nesting: units can share lines
  parent?: Unit
}

const [mode, ...extra] = Bun.argv.slice(2)
if (mode !== "names" && mode !== "behavior") {
  console.error(`tests: first argument must be names or behavior (got ${JSON.stringify(mode)})`)
  process.exit(2)
}
const paths = await inputPaths("tests", extra)

const jsCalls = "it|test|describe|context|suite|specify|beforeEach|afterEach|beforeAll|afterAll|before|after"
// Rule ids must be unique in one scan; `call/TypeScript` is read as `call`.
const jsRules = (language: string) => `
id: call/${language}
language: ${language}
rule:
  kind: call_expression
  all:
    - has: {field: function, regex: '^(${jsCalls})(\\.\\w+)*(\\(|$)'}
    - has: {field: arguments, has: {any: [{kind: arrow_function}, {kind: function_expression}]}}
---
id: helper/${language}
language: ${language}
rule:
  any:
    - kind: function_declaration
    - kind: class_declaration
    - kind: lexical_declaration
      has: {kind: variable_declarator, has: {field: value, any: [{kind: arrow_function}, {kind: function_expression}]}}
  inside: {any: [{kind: program}, {kind: export_statement}]}
`
const rules = [
  ...["TypeScript", "Tsx", "JavaScript"].map(jsRules),
  `
id: def
language: Python
rule: {kind: function_definition}
---
id: decorated
language: Python
rule: {kind: decorated_definition}
---
id: class
language: Python
rule: {kind: class_definition}
---
id: func
language: Go
rule: {any: [{kind: function_declaration}, {kind: method_declaration}]}
---
id: run
language: Go
rule:
  kind: call_expression
  all:
    - has: {field: function, regex: '\\.Run$'}
    - has: {field: arguments, has: {kind: func_literal}}
`
].join("\n---\n")

interface Match {
  readonly ruleId: string
  readonly file: string
  readonly text: string
  readonly range: {
    readonly byteOffset: { readonly start: number; readonly end: number }
    readonly start: { readonly line: number }
    readonly end: { readonly line: number }
  }
}

const scan = async (files: ReadonlyArray<string>): Promise<Array<Match>> => {
  if (files.length === 0) return []
  const result = await Bun.$`ast-grep scan --inline-rules ${rules} --json=stream ${files}`.quiet().nothrow()
  if (result.exitCode !== 0) {
    console.error(`tests: ast-grep failed: ${result.stderr.toString()}`)
    process.exit(2)
  }
  // ast-grep streams matches in no fixed order; sort them so the output never depends on it.
  return result.stdout.toString().split("\n").filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Match)
    .map((match) => ({ ...match, ruleId: match.ruleId.split("/")[0]! }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.range.byteOffset.start - b.range.byteOffset.start ||
      a.range.byteOffset.end - b.range.byteOffset.end || a.ruleId.localeCompare(b.ruleId))
}

const quoted = /^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`)/
const firstString = (args: string) => {
  const match = quoted.exec(args)
  return match === null ? undefined : (match[1] ?? match[2] ?? match[3])
}

/** The test units in one file, from its ast-grep matches. */
const unitsOf = (matches: ReadonlyArray<Match>): Array<Unit> => {
  const units: Array<Unit> = []
  // A decorated Python definition starts at its first decorator: the decorated range that ends with it and
  // starts nearest before it. (A class can end where its last decorated method does.)
  const decorated = matches.filter((match) => match.ruleId === "decorated").map((match) => match.range)
  const decoratedRange = (range: Match["range"]) =>
    decorated
      .filter((d) => d.byteOffset.end === range.byteOffset.end && d.byteOffset.start < range.byteOffset.start)
      .sort((a, b) => b.byteOffset.start - a.byteOffset.start)[0]
  for (const match of matches) {
    const range = (match.ruleId === "def" || match.ruleId === "class" ? decoratedRange(match.range) : undefined) ?? match.range
    const add = (kind: Kind, name: string, literal = true) =>
      units.push({
        kind, name, literal,
        start: range.start.line + 1, end: range.end.line + 1,
        bytes: [range.byteOffset.start, range.byteOffset.end]
      })
    const head = match.text.split("\n")[0]!
    if (match.ruleId === "call") {
      const callee = /^[\w.]+/.exec(match.text)![0]
      const base = callee.split(".")[0]!
      // `it.each(table)('name', fn)`: the name follows the table call.
      const tableArgs = /^[\w.]+\([\s\S]*?\)\s*\(/.exec(match.text)
      const args = callee.endsWith(".each") && tableArgs !== null
        ? match.text.slice(tableArgs[0].length)
        : match.text.slice(callee.length + 1)
      const name = firstString(args)
      if (/^(before|after)/.test(base)) add("helper", callee)
      else if (name !== undefined) add(/^(describe|context|suite)$/.test(base) ? "suite" : "test", name)
    } else if (match.ruleId === "helper") {
      add("helper", /(?:function\*?|class|const|let|var)\s+([\w$]+)/.exec(head)?.[1] ?? head.trim())
    } else if (match.ruleId === "def") {
      const name = /def\s+(\w+)/.exec(head)![1]!
      add(/^test/.test(name) ? "test" : "helper", name)
    } else if (match.ruleId === "class") {
      add("suite", /class\s+(\w+)/.exec(head)![1]!)
    } else if (match.ruleId === "func") {
      const name = /func\s+(?:\([^)]*\)\s*)?(\w+)/.exec(head)![1]!
      add(/^(Test|Fuzz)/.test(name) ? "test" : "helper", name)
    } else if (match.ruleId === "run") {
      const args = match.text.slice(match.text.indexOf("(") + 1)
      const name = firstString(args)
      add("subtest", name ?? args.split(",")[0]!.trim(), name !== undefined)
    }
  }
  units.sort((a, b) => a.bytes[0] - b.bytes[0] || b.bytes[1] - a.bytes[1])
  const nest = (all: Array<Unit>) => {
    // Each unit's parent: the innermost unit that contains it.
    const open: Array<Unit> = []
    for (const unit of all) {
      while (open.length > 0 && open.at(-1)!.bytes[1] < unit.bytes[1]) open.pop()
      unit.parent = open.at(-1)
      open.push(unit)
    }
    return all
  }
  // A helper that declares tests is a wrapper. A test nested in a test or helper is a subtest; anything else
  // inside one is part of it.
  nest(units)
  const declaresTests = (unit: Unit) => units.some((u) => u.kind !== "helper" && ancestors(u).includes(unit))
  const kinds = units.map((unit) => (unit.kind === "helper" && declaresTests(unit) ? { ...unit, kind: "wrapper" as const } : { ...unit }))
  return nest(nest(kinds).flatMap((unit) => {
    if (ancestors(unit).every((a) => a.kind === "suite" || a.kind === "wrapper")) return [unit]
    return unit.kind === "test" || unit.kind === "subtest" ? [{ ...unit, kind: "subtest" as const }] : []
  }))
}

const ancestors = (unit: Unit) => {
  const result: Array<Unit> = []
  for (let at = unit.parent; at !== undefined; at = at.parent) result.push(at)
  return result
}

const numbered = (lines: ReadonlyArray<string>, numbers: ReadonlyArray<number>) =>
  numbers.map((n) => `${n}: ${lines[n - 1]!.trim()}`).join("\n")
const capped = (found: ReadonlyArray<string>, max: number) =>
  found.length <= max ? found.join("\n") : [...found.slice(0, max), `… and ${found.length - max} more`].join("\n")

/** Line numbers in `unit` that are its own: not inside one of its subtests. */
const ownLines = (unit: Unit, units: ReadonlyArray<Unit>) => {
  const nested = units.filter((u) => u !== unit && ancestors(u).includes(unit) && u.kind === "subtest" && u.literal)
  const own: Array<number> = []
  for (let n = unit.start; n <= unit.end; n++) if (!nested.some((u) => u.start <= n && n <= u.end)) own.push(n)
  return own
}

type Language = "js" | "py" | "go"
const languageOf = (path: string): Language | undefined =>
  /\.[cm]?[jt]sx?$/.test(path) ? "js" : path.endsWith(".py") ? "py" : path.endsWith(".go") ? "go" : undefined

const assertion: Record<Language, RegExp> = {
  js: /\b(expect|assert)\b|\bt\.(is|not|deepEqual|notDeepEqual|true|false|truthy|falsy|throws|throwsAsync|notThrows|regex|like|snapshot|pass|fail)\b|\.should\b/,
  py: /^\s*assert\b|\bself\.(assert|fail)\w*\(|\bpytest\.(raises|warns|fail)\b|\.assert_\w+\(|\bassert_\w+\(/,
  go: /\b(assert|require)\.\w+\(|\bt\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\(|\bcmp\.Diff\(|\bt\.Log/
}

/** What a test checks: its assertion lines (for Go, the `if` before a `t.Error`), outside its subtests. */
const checks = (language: Language, lines: ReadonlyArray<string>, own: ReadonlyArray<number>) => {
  const found = new Set<number>()
  for (const n of own) {
    if (!assertion[language].test(lines[n - 1]!)) continue
    if (language === "go" && /^\s*t\.(Error|Fatal|Fail)/.test(lines[n - 1]!) && /^\s*(if|}\s*else)\b/.test(lines[n - 2] ?? "")) found.add(n - 1)
    found.add(n)
  }
  return [...found].sort((a, b) => a - b)
}

// ---- behavior evidence: computed facts about what a unit touches ----

interface FileFacts {
  readonly language: Language
  readonly lines: ReadonlyArray<string>
  readonly privateImports: ReadonlySet<string> // Python names imported with a leading underscore
  readonly pyClasses: ReadonlySet<string> // Python classes the test file declares (its own helpers)
  readonly goImports: ReadonlySet<string> // Go package names imported by the file
  readonly goVariables: ReadonlySet<string> // Go variables, parameters, and functions the test file declares
  readonly goTableVariables: ReadonlySet<string> // Go range variables: rows of the test's own tables
  readonly goMembers: ReadonlySet<string> // fields and methods of Go types the test file declares
  readonly goSamePackage: boolean // the Go test is in the package under test, so it can reach unexported names
}

const factsOf = (language: Language, source: string): FileFacts => {
  const lines = source.split("\n")
  const privateImports = new Set<string>()
  const pyClasses = new Set<string>()
  const goImports = new Set<string>()
  const goVariables = new Set<string>()
  const goTableVariables = new Set<string>()
  const goMembers = new Set<string>()
  if (language === "py") {
    for (const m of source.matchAll(/^\s*from\s+[\w.]+\s+import\s+\(?([^)\n]*(?:\n[^)\n]*)*?)\)?\s*$/gm)) {
      for (const name of m[1]!.split(/[,\s]+/)) if (/^_[a-zA-Z]/.test(name)) privateImports.add(name)
    }
    for (const m of source.matchAll(/^\s*class\s+(\w+)/gm)) pyClasses.add(m[1]!)
  }
  if (language === "go") {
    const block = /^import\s*\(([\s\S]*?)^\)/m.exec(source)?.[1] ?? ""
    const singles = [...source.matchAll(/^import\s+(\w+\s+)?"[^"]+"/gm)].map((m) => m[0])
    for (const spec of [...block.split("\n"), ...singles]) {
      const m = /(?:^|\s)(\w+)?\s*"([^"]+)"/.exec(spec)
      if (m === null) continue
      goImports.add(m[1] ?? m[2]!.split("/").at(-1)!.replace(/^go-/, "").replace(/\.v\d+$/, "").replace(/-/g, "_"))
    }
    const names = (list: string) => list.split(/\s*,\s*/).filter((n) => n !== "_")
    for (const m of source.matchAll(/\b(\w+(?:\s*,\s*\w+)*)\s*:=/g)) for (const n of names(m[1]!)) goVariables.add(n)
    for (const m of source.matchAll(/\b(?:var|const)\s+(\w+(?:\s*,\s*\w+)*)/g)) for (const n of names(m[1]!)) goVariables.add(n)
    for (const m of source.matchAll(/\bfunc\s+(?:\([^)]*\)\s*)?(\w+)/g)) goVariables.add(m[1]!)
    for (const m of source.matchAll(/^(?:var|const)\s*\(([\s\S]*?)^\)/gm)) for (const d of m[1]!.matchAll(/^\s*(\w+)/gm)) goVariables.add(d[1]!)
    for (const m of source.matchAll(/\bfor\s+(\w+(?:\s*,\s*\w+)?)\s*:=\s*range\b/g)) for (const n of names(m[1]!)) goTableVariables.add(n)
    for (const m of source.matchAll(/func\s*(?:\([^)]*\)\s*)?\w*\s*\(([^)]*)\)/g)) {
      for (const param of m[1]!.split(",")) { const n = /^\s*(\w+)/.exec(param)?.[1]; if (n) goVariables.add(n) }
    }
    for (const m of source.matchAll(/^type\s+\w+\s+struct\s*\{([\s\S]*?)^\}/gm)) for (const f of m[1]!.matchAll(/^\s*(\w+)/gm)) goMembers.add(f[1]!)
    for (const m of source.matchAll(/^func\s*\([^)]*\)\s*(\w+)/gm)) goMembers.add(m[1]!)
  }
  const goPackage = /^package\s+(\w+)/m.exec(source)?.[1] ?? ""
  return {
    language, lines, privateImports, pyClasses, goImports, goVariables, goTableVariables, goMembers,
    goSamePackage: !goPackage.endsWith("_test")
  }
}

const withoutStrings = (code: string) => code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '""')

/** Members of the code under test that are private by convention, touched on a line. */
const privateTouches = (facts: FileFacts, line: string): Array<string> => {
  const raw = line.replace(facts.language === "py" ? /#.*$/ : /\/\/.*$/, "")
  const code = withoutStrings(raw)
  const found: Array<string> = []
  if (facts.language === "py") {
    for (const m of code.matchAll(/\b([A-Za-z_][\w.]*?)\.(_[A-Za-z]\w*)\b/g)) {
      if (/^(self|cls)$/.test(m[1]!) || facts.pyClasses.has(m[1]!.split(".")[0]!)) continue
      found.push(`${m[1]}.${m[2]}`)
    }
    for (const m of raw.matchAll(/\b(?:getattr|setattr|hasattr)\(\s*([\w.]+)\s*,\s*["'](_[A-Za-z]\w*)["']/g)) found.push(`${m[1]}.${m[2]}`)
    for (const m of code.matchAll(/(?<![\w.])(_[A-Za-z]\w*)\b/g)) if (facts.privateImports.has(m[1]!)) found.push(`${m[1]} (imported private name)`)
  }
  if (facts.language === "js") {
    for (const m of code.matchAll(/\bas\s+(?:unknown\s+as\s+|any\b)[^)]*\)\s*\??\.\s*([\w$#]+)/g)) found.push(`${m[1]} (read through a cast)`)
    for (const m of code.matchAll(/\bas\s+unknown\s+as\s+\{\s*([\w$]+)\s*[:(?]/g)) found.push(`${m[1]} (typed through a cast to reach it)`)
    for (const m of raw.matchAll(/\b([\w$]+)\[\s*["'`]([\w$]+)["'`]\s*\]/g)) if (!/^(process|env|headers|window|globalThis)$/.test(m[1]!)) found.push(`${m[1]}["${m[2]}"] (bracket access)`)
    for (const m of code.matchAll(/\b([\w$]+)\.(_[\w$]+|#[\w$]+)\b/g)) found.push(`${m[1]}.${m[2]}`)
    if (/@ts-(ignore|expect-error)/.test(line)) found.push("type check suppressed")
  }
  if (facts.language === "go" && facts.goSamePackage) {
    for (const m of code.matchAll(/(?<![\w.])([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)+)/g)) {
      if (facts.goImports.has(m[1]!) || facts.goTableVariables.has(m[1]!) || /^(t|b|f|tb)$/.test(m[1]!)) continue
      for (const field of m[2]!.slice(1).split(".")) {
        if (/^[a-z_]/.test(field) && !facts.goMembers.has(field)) found.push(`${m[1]}${m[2]} (unexported ${field})`)
      }
    }
    const assigned = /^\s*([a-z_]\w*)\s*=[^=]/.exec(code)?.[1]
    if (assigned !== undefined && assigned !== "_" && !facts.goVariables.has(assigned)) found.push(`${assigned} (package variable set by the test)`)
  }
  return [...new Set(found)]
}

// What a unit fakes, and what it asserts about calls, as short facts. Each fact is a pattern and how to word a
// match; arguments may continue on the next lines (multi-line decorators), so patterns see two more lines.
type Fact = readonly [RegExp, (m: RegExpExecArray) => string]
const q = `["'\`]`
const mockFacts: Record<Language, ReadonlyArray<Fact>> = {
  py: [
    [new RegExp(`\\bpatch\\(\\s*(?:target\\s*=\\s*)?${q}([\\w.]+)${q}`, "g"), (m) => `${m[1]} patched`],
    [new RegExp(`\\bpatch\\.object\\(\\s*([\\w.]+)\\s*,\\s*${q}(\\w+)${q}`, "g"), (m) => `${m[1]}.${m[2]} patched`],
    [/\bpatch\.dict\(\s*([\w.]+|["'][\w.]+["'])/g, (m) => `dict ${m[1]} patched`],
    [new RegExp(`\\bmonkeypatch\\.setattr\\(\\s*([\\w.]+)\\s*,\\s*${q}(\\w+)${q}`, "g"), (m) => `${m[1]}.${m[2]} replaced`],
    [new RegExp(`\\bmonkeypatch\\.setattr\\(\\s*${q}([\\w.]+)${q}`, "g"), (m) => `${m[1]} replaced`],
    [new RegExp(`\\bmonkeypatch\\.(?:setenv|delenv)\\(\\s*${q}(\\w+)${q}`, "g"), (m) => `environment variable ${m[1]} set`],
    [new RegExp(`\\bmocker\\.spy\\(\\s*([\\w.]+)\\s*,\\s*${q}(\\w+)${q}`, "g"), (m) => `${m[1]}.${m[2]} spied on`],
    [/(?:^|[^\w.])(\w+)\s*=\s*(?:\w+\.)*(Magic|Async|NonCallable)?Mock\(\s*(?:spec(?:_set)?\s*=\s*([\w.]+))?/g,
      (m) => `${m[1]} is a ${m[2] ?? ""}Mock${m[3] === undefined ? "" : ` of ${m[3]}`}`],
    [/\bcreate_autospec\(\s*([\w.]+)/g, (m) => `autospec mock of ${m[1]}`],
    [/\b(respx|responses\.add|httpx_mock|requests_mock|aioresponses)\b/g, () => "HTTP requests faked"],
    [/\b(freeze_time|freezegun|time_machine)\b/g, () => "clock frozen"]
  ],
  js: [
    [new RegExp(`\\b(?:vi|jest)\\.(?:mock|doMock)\\(\\s*${q}([^"'\`]+)${q}`, "g"), (m) => `module "${m[1]}" mocked`],
    [new RegExp(`\\b(?:vi|jest)\\.spyOn\\(\\s*([\\w$.]+)\\s*,\\s*${q}([\\w$]+)${q}`, "g"), (m) => `${m[1]}.${m[2]} spied on`],
    [/([\w$.]+)\s*[:=]\s*(?:vi|jest)\.fn\(/g, (m) => `${m[1]} is a mock function`],
    [/\b(?:vi|jest|sinon)\.useFakeTimers\(/g, () => "clock faked"],
    [new RegExp(`\\b(?:vi|jest)\\.stubGlobal\\(\\s*${q}([\\w$]+)${q}`, "g"), (m) => `global ${m[1]} stubbed`],
    [new RegExp(`\\b(?:vi|jest)\\.stubEnv\\(\\s*${q}([\\w$]+)${q}`, "g"), (m) => `environment variable ${m[1]} stubbed`],
    [new RegExp(`\\bsinon\\.(stub|spy|mock|replace)\\(\\s*([\\w$.]+)(?:\\s*,\\s*${q}([\\w$]+)${q})?`, "g"),
      (m) => `${m[2]}${m[3] === undefined ? "" : `.${m[3]}`} ${m[1] === "spy" ? "spied on" : `${m[1]}bed`}`.replace("replacebed", "replaced")],
    [/(?:vi\.mocked\(\s*([\w$.]+)\s*\)|([\w$.]+))\.mock(?:Implementation|ReturnValue|ResolvedValue|RejectedValue)\w*\(/g,
      (m) => `${m[1] ?? m[2]} given canned behavior`],
    [/\b(?:globalThis|global|window)\.fetch\s*=[^=]/g, () => "global fetch replaced"],
    [/\b(nock|msw|setupServer|fetchMock)\b/g, () => "HTTP requests faked"]
  ],
  go: [
    [/\.EXPECT\(\)\.(\w+)\(/g, (m) => `mock expects a call to ${m[1]}`],
    [/\b(\w+)\.On\(\s*"(\w+)"/g, (m) => `mock ${m[1]} expects a call to ${m[2]}`],
    [/\bhttptest\.New(?:TLS)?Server\b/g, () => "fake HTTP server"],
    [/\bhttptest\.NewRecorder\b/g, () => "HTTP response recorder"],
    [/\bNewMock(\w+)\(/g, (m) => `generated mock of ${m[1]}`]
  ]
}
const calledPhrase: Record<string, string> = {
  not_called: "asserted not called", called_once_with: "asserted called once with specific arguments",
  called_once: "asserted called exactly once", called_with: "asserted called with specific arguments",
  called: "asserted called", any_call: "asserted called with specific arguments at some point",
  has_calls: "asserted to receive a specific sequence of calls", awaited: "asserted awaited",
  awaited_once: "asserted awaited exactly once", awaited_with: "asserted awaited with specific arguments",
  awaited_once_with: "asserted awaited once with specific arguments", not_awaited: "asserted not awaited"
}
const callFacts: Record<Language, ReadonlyArray<Fact>> = {
  py: [
    [/([\w.]+)\.assert_((?:not_)?(?:called|awaited)\w*|any_call|has_calls)\(/g, (m) => `${m[1]} ${calledPhrase[m[2]!] ?? `checked with assert_${m[2]}`}`],
    [/([\w.]+)\.(?:call_count|await_count)\b/g, (m) => `number of calls to ${m[1]} checked`],
    [/([\w.]+)\.(?:call_args(?:_list)?|mock_calls|await_args(?:_list)?|method_calls)\b/g, (m) => `arguments of calls to ${m[1]} checked`],
    [/\bassert\s+(not\s+)?([\w.]+)\.called\b/g, (m) => `${m[2]} asserted ${m[1] === undefined ? "" : "not "}called`]
  ],
  js: [
    [/expect\(\s*([^()]+?(?:\([^()]*\))?)\s*\)\s*(\.not)?\s*\.(?:toHaveBeenCalledTimes|toBeCalledTimes)\(\s*([^)]*)\)/g,
      (m) => `${m[1]} asserted ${m[2] === undefined ? "" : "not "}called ${m[3]} times`],
    [/expect\(\s*([^()]+?(?:\([^()]*\))?)\s*\)\s*(\.not)?\s*\.(?:toHaveBeenCalledWith|toBeCalledWith|toHaveBeenLastCalledWith|lastCalledWith)\(/g,
      (m) => `${m[1]} asserted ${m[2] === undefined ? "" : "not "}called with specific arguments`],
    [/expect\(\s*([^()]+?(?:\([^()]*\))?)\s*\)\s*\.(?:toHaveBeenNthCalledWith|nthCalledWith)\(\s*(\w+)/g, (m) => `arguments of call ${m[2]} to ${m[1]} asserted`],
    [/expect\(\s*([^()]+?(?:\([^()]*\))?)\s*\)\s*(\.not)?\s*\.(?:toHaveBeenCalled|toBeCalled)\(\s*\)/g,
      (m) => `${m[1]} asserted ${m[2] === undefined ? "" : "not "}called`],
    [/([\w$.]+)\.mock\.(?:calls|results|lastCall)\b/g, (m) => `calls to ${m[1]} inspected`],
    [/([\w$.]+)\.(calledOnce|calledTwice|calledThrice|calledWith\w*|callCount|notCalled|callOrder)\b/g, (m) => `${m[1]}.${m[2]} checked`]
  ],
  go: [
    [/\.AssertCalled\(\s*\w+\s*,\s*"(\w+)"/g, (m) => `${m[1]} asserted called`],
    [/\.AssertNotCalled\(\s*\w+\s*,\s*"(\w+)"/g, (m) => `${m[1]} asserted not called`],
    [/\.AssertNumberOfCalls\(\s*\w+\s*,\s*"(\w+)"\s*,\s*(\w+)/g, (m) => `${m[1]} asserted called ${m[2]} times`],
    [/\.AssertExpectations\(/g, () => "all expected mock calls asserted"],
    [/\.EXPECT\(\)\.(\w+)\([^\n]*?\.(Times|MinTimes|MaxTimes)\((\w+)\)/g, (m) => `${m[1]} expected ${m[2] === "Times" ? "" : `${m[2]} `}${m[3]} times`]
  ]
}

// Fakes of these are fakes of true external boundaries, which the rule allows.
const boundaries: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(requests|httpx|urllib\d?|urlopen|socket|aiohttp|fetch|axios|grpc|smtplib|boto3|botocore|websockets?|https?|HTTP)\b/i, "network"],
  [/\b(time|datetime|sleep|monotonic|now|utcnow|Date|setTimeout|setInterval|clock|timers?)\b/, "clock"],
  [/\b(open|os\.path|pathlib|Path|shutil|fs|tempfile|readFile\w*|writeFile\w*|glob)\b/, "filesystem"],
  [/\b(db|database|session|cursor|sql\w*|redis|mongo\w*|sqlite3|psycopg2?)\b/i, "database"],
  [/\b(subprocess|environ|env|environment|child_process|exec|spawn)\b/, "process or environment"],
  [/\b(random|uuid\d?|secrets|randomUUID)\b/, "randomness"]
]
const boundaryOf = (fact: string) => boundaries.find(([pattern]) => pattern.test(fact))?.[1]

const behaviorEvidence = (facts: FileFacts, numbers: ReadonlyArray<number>) => {
  const found = { touched: new Map<string, Array<number>>(), mocked: new Map<string, Array<number>>(), calls: new Map<string, Array<number>>() }
  const note = (map: Map<string, Array<number>>, fact: string, n: number) => {
    const at = map.get(fact) ?? []
    if (!at.includes(n)) map.set(fact, [...at, n])
  }
  for (const n of numbers) {
    const line = facts.lines[n - 1]!
    for (const member of privateTouches(facts, line)) note(found.touched, member, n)
    const window = [line, ...facts.lines.slice(n, n + 2)].join("\n")
    for (const [list, map] of [[mockFacts, found.mocked], [callFacts, found.calls]] as const) {
      for (const [pattern, word] of list[facts.language]) {
        for (const m of window.matchAll(pattern)) if (m.index < line.length) note(map, word(m as RegExpExecArray), n)
      }
    }
  }
  const where = (lines: ReadonlyArray<number>) => `line${lines.length > 1 ? "s" : ""} ${lines.join(", ")}`
  const listed = (map: Map<string, Array<number>>, boundary = false) =>
    capped([...map].map(([fact, lines]) => {
      const kind = boundary ? boundaryOf(fact) : undefined
      return `${fact}${kind === undefined ? "" : ` [${kind}: an external boundary]`} (${where(lines)})`
    }), 20) || "none found"
  return {
    private_members_touched: listed(found.touched),
    mocks_and_patches: listed(found.mocked, true),
    assertions_on_calls: listed(found.calls)
  }
}

// ---- main ----

const items: Array<string> = []
// ast-grep reports paths normalized (`./a.ts` as `a.ts`), so matches are keyed by absolute path.
const byPath = new Map<string, Array<Match>>()
for (const match of await scan(paths.filter((path) => languageOf(path) !== undefined))) {
  const key = resolve(match.file)
  byPath.set(key, [...(byPath.get(key) ?? []), match])
}
for (const path of paths) {
  const language = languageOf(path)
  if (language === undefined) continue
  const source = await Bun.file(path).text()
  const lines = source.split("\n")
  const units = unitsOf(byPath.get(resolve(path)) ?? [])
  const facts = mode === "behavior" ? factsOf(language, source) : undefined
  const childrenOf = (unit: Unit) => units.filter((u) => u.parent === unit)
  const label = (unit: Unit) => `${unit.kind} ${JSON.stringify(unit.name)}`
  for (const unit of units) {
    const suite = ancestors(unit).reverse().map((a) => a.name).join(" > ")
    // Units can start on the same line (`describe('x', () => { it('y', …`): later ones add their column offset.
    const shared = units.some((u) => u !== unit && u.start === unit.start && u.bytes[0] < unit.bytes[0])
    const id = shared ? `${path}:${unit.start}+${unit.bytes[0]}` : `${path}:${unit.start}`
    const describeBlock = unit.kind === "suite" && language === "js"
    if (mode === "names") {
      if (describeBlock) {
        items.push(JSON.stringify({
          id, path, lines: [unit.start, unit.end],
          kind: "describe block: names a group of tests",
          suite,
          tests: capped(childrenOf(unit).filter((u) => u.kind !== "helper").map(label), 30),
          text: unit.name
        }))
      }
      if (unit.kind !== "test" && unit.kind !== "subtest") continue
      const own = ownLines(unit, units)
      const subtests = childrenOf(unit).filter((u) => u.kind === "subtest")
      // Go table tests: subtests named from the table (`t.Run(tt.name, …)`) take the case names written in the
      // table, which is in the test that runs them.
      const table = unit.literal ? unit : unit.parent ?? unit
      const cases = language === "go" && (!unit.literal || subtests.some((u) => !u.literal))
        ? [...lines.slice(table.start - 1, table.end).join("\n").matchAll(/\b(?:name|desc|description|title|scenario)\s*:\s*("(?:[^"\\]|\\.)*"|`[^`]*`)/gi)].map((m) => m[1]!)
        : []
      items.push(JSON.stringify({
        id, path, lines: [unit.start, unit.end],
        kind: unit.literal ? unit.kind : `subtest named per table row by \`${unit.name}\` (the rows' names are in table_case_names)`,
        suite,
        subtests: capped(subtests.filter((u) => u.literal).map((u) => JSON.stringify(u.name)), 30),
        table_case_names: capped(cases, 30),
        checks: capped(checks(language, lines, own).map((n) => `${n}: ${lines[n - 1]!.trim()}`), 25) || "no assertions found",
        text: unit.name
      }))
    } else if (describeBlock || unit.kind === "wrapper") {
      // Evidence covers the block's own code: shared setup outside its tests, hooks, and helpers.
      const inner = childrenOf(unit)
      const own: Array<number> = []
      for (let n = unit.start + 1; n < unit.end; n++) {
        if (lines[n - 1]!.trim() !== "" && !inner.some((u) => u.start <= n && n <= u.end)) own.push(n)
      }
      if (unit.kind === "wrapper" && own.length === 0) continue
      items.push(JSON.stringify({
        id, path, lines: [unit.start, unit.end],
        role: `${describeBlock ? "describe block" : "function that declares tests"}; the evidence covers its own code, outside the tests, hooks, and helpers in it`,
        suite,
        ...behaviorEvidence(facts!, own),
        text: lines.slice(unit.start - 1, unit.end).join("\n")
      }))
    } else if (unit.kind !== "suite") {
      const all: Array<number> = []
      for (let n = unit.start; n <= unit.end; n++) all.push(n)
      items.push(JSON.stringify({
        id, path, lines: [unit.start, unit.end],
        role: unit.kind === "test" ? "test" : unit.kind === "subtest" ? "subtest" : "helper, fixture, or hook shared by tests",
        suite,
        ...behaviorEvidence(facts!, all),
        text: lines.slice(unit.start - 1, unit.end).join("\n")
      }))
    }
  }
}
if (items.length > 0) await new Promise<void>((resolve) => process.stdout.write(`${items.join("\n")}\n`, () => resolve()))

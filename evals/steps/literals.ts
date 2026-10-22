// Eval selector: `bun "$EVAL_STEPS/literals.ts" "$@"` emits each line of the TypeScript, JavaScript,
// Python, and Go files given that holds a literal which might need a name: a number other than 0 and 1 (or
// a 1 in a duration or shift), or a string that is neither prose, a format string, nor empty. Literals that
// already have a name are left out (module-level and ALL_CAPS constants, Go `const`, package `var`s, enum
// members), and so are literals that carry no decision: imports, type positions, struct tags, object and
// map keys, JSX attributes, docstrings, assertions, and arguments to logging, printing, and test names.
// Evidence: the literals the line holds (`literals`), and where the same literals appear elsewhere in the
// file and the constants already named with those values (`elsewhere`). Pipe the items through
// `enclosing.ts` for the code around them.
import { $ } from "bun"

// Calls whose arguments are messages, not decisions: logging, printing, test names, assertions.
const messageCall = "(?i)(^|\\\\.)(log\\\\w*|logger|print\\\\w*|printf|sprintf|errorf|fatal\\\\w*|panic\\\\w*|warn\\\\w*|info\\\\w*|debug\\\\w*|trace|error|exception|assert\\\\w*|t\\\\.run|describe|it|test|skip|gettext|_)$"
// Type positions (TypeScript) and JSX attributes (TSX, JavaScript) exist only in some grammars.
const typeKinds = ["literal_type", "type_annotation", "enum_body", "property_signature"]
const script = (language: string, kinds: ReadonlyArray<string>) => `
id: literal
language: ${language}
rule:
  any:
    - kind: number
    - kind: string
    - kind: template_string
      not: { has: { kind: template_substitution } }
  not:
    any:
      - inside: { kind: import_statement, stopBy: end }
      - inside: { kind: export_statement, has: { field: source, kind: string } }
${kinds.map((kind) => `      - inside: { kind: ${kind}, stopBy: end }`).join("\n")}
      - inside: { kind: pair, field: key }
      - inside:
          kind: arguments
          inside:
            any:
              - { kind: call_expression, has: { field: function, regex: "${messageCall}" } }
              - { kind: new_expression, has: { field: constructor, regex: "${messageCall}" } }
      - inside:
          kind: call_expression
          has: { field: function, regex: "^(require|import)$" }
          stopBy: end
      - inside:
          kind: lexical_declaration
          regex: "^const"
          inside: { any: [ { kind: program }, { kind: export_statement } ] }
          stopBy: { any: [ { kind: arrow_function }, { kind: function_expression }, { kind: function_declaration }, { kind: method_definition }, { kind: class_body } ] }
      - inside:
          kind: variable_declarator
          has: { field: name, regex: "^[A-Z][A-Z0-9_]+$" }
          stopBy: { any: [ { kind: arrow_function }, { kind: function_expression } ] }
`
const rules = [
  script("typescript", typeKinds),
  script("tsx", [...typeKinds, "jsx_attribute"]),
  script("javascript", ["jsx_attribute"]),
  `
id: literal
language: python
rule:
  any:
    - kind: integer
    - kind: float
    - kind: string
      not: { has: { kind: interpolation } }
  not:
    any:
      - inside: { kind: expression_statement }
      - inside: { kind: import_from_statement, stopBy: end }
      - inside: { kind: type, stopBy: end }
      - inside: { kind: pair, field: key }
      - inside:
          kind: argument_list
          inside: { kind: call, has: { field: function, regex: "${messageCall}" } }
      - inside:
          kind: keyword_argument
          inside: { kind: argument_list, inside: { kind: call, has: { field: function, regex: "${messageCall}" } } }
      - inside: { kind: assert_statement, stopBy: end }
      - inside:
          kind: assignment
          has: { field: left, regex: "^_*[A-Z][A-Z0-9_]*$" }
          stopBy: { any: [ { kind: lambda }, { kind: function_definition } ] }
`,
  `
id: literal
language: go
rule:
  any:
    - kind: int_literal
    - kind: float_literal
    - kind: interpreted_string_literal
    - kind: raw_string_literal
  not:
    any:
      - inside: { kind: import_declaration, stopBy: end }
      - inside: { kind: const_declaration, stopBy: end }
      - inside:
          kind: var_declaration
          inside: { kind: source_file }
          stopBy: { kind: func_literal }
      - inside: { kind: field_declaration, field: tag }
      - inside: { kind: literal_element, inside: { kind: keyed_element, field: key } }
      - inside:
          kind: argument_list
          inside: { kind: call_expression, has: { field: function, regex: "${messageCall}|^fmt\\\\." } }
`
].join("\n---\n")

interface Match {
  readonly file: string
  readonly text: string
  readonly range: { readonly start: { readonly line: number; readonly column: number } }
}

// A string literal's content, without quotes or a Python prefix.
const contentOf = (literal: string) => literal.replace(/^[rbuf]*("""|'''|["'`])/i, "").replace(/("""|'''|["'`])$/, "")
// Literals that need no name: 0 and 1 (outside durations and shifts), empty or one-character strings,
// prose (three or more words, or a sentence), and format strings.
const needsNoName = (literal: string, line: string) => {
  if (/^[\d._]/.test(literal)) {
    if (!/^(0|1)(\.0*)?$/.test(literal.replace(/_/g, ""))) return false
    return !(literal === "1" && /\b1\s*(\*\s*time\.|<<)|time\.\w+\s*\*\s*1\b/.test(line))
  }
  const content = contentOf(literal)
  if (content.trim().length <= 1) return true
  if (content.trim().split(/\s+/).length >= 3 || /[.!?:]\s*$/.test(content) && /\s/.test(content)) return true
  return /%[-+# 0-9.]*[sdvfqwxXtTeEgGcbopU]|\{\d*\}|\{\w+\}/.test(content)
}

const files = new Map<string, ReadonlyArray<string>>()
const linesOf = async (path: string) => {
  if (!files.has(path)) files.set(path, (await Bun.file(path).text()).split("\n"))
  return files.get(path)!
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// A line that gives `literal` a name, the literal being the whole value: a `const` (or `final`, `static`,
// `readonly`) declaration, an ALL_CAPS assignment, or a capitalized const-block or enum member.
const namingOf = (literal: string) => {
  const value = `\\s*(?::[^=]+)?=\\s*${escape(literal)}\\s*[;,]?\\s*(?:(?://|#).*)?$`
  return new RegExp(`^\\s*(?:export\\s+)?(?:const|final|static|readonly)\\s+(?:\\w+\\s+)*?\\w+${value}|^\\s*[A-Z_][A-Z0-9_]*${value}|^\\s+[A-Z]\\w*(?:\\s+\\w+)?${value}`)
}

// Where the line's literals also appear in the file (not for one-digit numbers, which recur everywhere),
// and the lines already naming those values.
const elsewhereOf = (lines: ReadonlyArray<string>, line: number, literals: ReadonlyArray<string>) =>
  literals.flatMap((literal) => {
    if (/^\d$/.test(literal)) return []
    const pattern = new RegExp(`(?<![\\w.])${escape(literal)}(?![\\w.])`)
    const others = lines.flatMap((text, index) => (index + 1 !== line && pattern.test(text) ? [index + 1] : []))
    if (others.length === 0) return []
    const naming = namingOf(literal)
    const named = others.filter((at) => naming.test(lines[at - 1]!))
    const shown = others.slice(0, 8).join(", ") + (others.length > 8 ? ", …" : "")
    const names = named.slice(0, 3).map((at) => `line ${at}: ${lines[at - 1]!.trim()}`).join("; ")
    return [`${literal} also on line${others.length > 1 ? "s" : ""} ${shown}${names === "" ? "" : `; named at ${names}`}`]
  }).join("\n")

const paths = Bun.argv.slice(2)
const out: Array<string> = []
if (paths.length > 0) {
  const run = await $`ast-grep scan --inline-rules ${rules} --json=stream ${paths}`.nothrow().quiet()
  if (run.exitCode !== 0) {
    console.error(`literals: ast-grep failed: ${run.stderr.toString()}`)
    process.exit(2)
  }
  const byLine = new Map<string, { file: string; line: number; literals: Array<string> }>()
  for (const raw of run.stdout.toString().split("\n")) {
    if (raw.trim() === "") continue
    const match = JSON.parse(raw) as Match
    const line = match.range.start.line + 1
    const lines = await linesOf(match.file)
    // One-line literals only: a multi-line string is text, not a value.
    if (match.text.includes("\n") || needsNoName(match.text, lines[line - 1]!)) continue
    const key = `${match.file}:${line}`
    const entry = byLine.get(key) ?? { file: match.file, line, literals: [] }
    if (!entry.literals.includes(match.text)) entry.literals.push(match.text)
    byLine.set(key, entry)
  }
  for (const [key, { file, line, literals }] of byLine) {
    const lines = files.get(file)!
    out.push(JSON.stringify({
      id: key,
      path: file,
      lines: [line, line],
      text: lines[line - 1]!,
      literals: literals.join(", "),
      elsewhere: elsewhereOf(lines, line, literals)
    }))
  }
}
if (out.length > 0) await new Promise<void>((resolve) => process.stdout.write(`${out.join("\n")}\n`, () => resolve()))

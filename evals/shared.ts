// Measures selector sharing: policies with the same `select` should run it once per lint run. Lints this
// repository's `src/` and README with six policies sharing one selector (which keeps only `src/*.ts`),
// against a stub Clef (no requests), and counts executions through a log the selector appends to.
//   bun evals/shared.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Result } from "effect"
import { Clef } from "../src/clef.ts"
import { defaultThreshold, lint } from "../src/lint.ts"
import { readPaths } from "../src/source.ts"
import { adHocPolicy } from "./corpus.ts"

const directory = mkdtempSync(join(tmpdir(), "lint-anything-shared-"))
const log = join(directory, "runs.log")
process.env.RUNS_LOG = log
const rules = ["Names describe intent.", "Comments explain why.", "Values that carry meaning are named.",
  "Errors keep their context.", "Functions do one thing.", "Exports are minimal."]
// Each `const` line in src/*.ts with its enclosing block.
const select = `echo select >> "$RUNS_LOG"
for f do shift; case $f in src/*.ts) set -- "$@" "$f";; esac; done
[ $# -gt 0 ] || exit 0
rg --json -w 'const' "$@" |
  jq -c 'select(.type == "match") | {id: "\\(.data.path.text):\\(.data.line_number)", path: .data.path.text, lines: [.data.line_number, .data.line_number], text: (.data.lines.text | rtrimstr("\\n"))}' |
  bun "$EVAL_STEPS/enclosing.ts" |
  bun "$EVAL_STEPS/present.ts"`
const policies = rules.map((rule, index) => adHocPolicy(`shared/${index}`, select, `# Rule ${index}\n\n${rule}`))

// Every judgment scores 0.1; this eval measures the steps, not Clef.
const stub = Layer.succeed(Clef, Clef.of({
  judgeItems: (_, items) => Effect.succeed(items.map(() => Result.succeed({ violates: 0.1 }))),
  stats: Effect.succeed({ requests: 0, cached: 0 })
}))

const started = performance.now()
const findings = await Effect.runPromise(
  readPaths(["src/**/*", "README.md"]).pipe(
    Effect.flatMap((paths) => lint(paths, policies, defaultThreshold)),
    Effect.provide(Layer.mergeAll(stub, BunServices.layer))
  )
)
const ms = performance.now() - started
const runs = readFileSync(log, "utf8").trim().split("\n")
rmSync(directory, { recursive: true, force: true })
const count = (kind: string) => runs.filter((run) => run === kind).length
const perPolicy = new Map<string, number>()
for (const finding of findings) perPolicy.set(finding.policy, (perPolicy.get(finding.policy) ?? 0) + 1)
console.log(`${policies.length} policies sharing one selector over src/** and README.md (it keeps src/*.ts):`)
console.log(`- selector ran ${count("select")} time(s) (without sharing: ${policies.length})`)
console.log(`- ${findings.length} findings, ${[...new Set(perPolicy.values())].join("/")} per policy; ${Math.round(ms)} ms`)
const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify(findings.map((finding) => JSON.stringify(finding)).sort())).digest("hex")
console.log(`- findings digest ${digest.slice(0, 16)}`)

#!/usr/bin/env bun
// The lint-anything skill's reusable selector helpers, bundled to skills/lint-anything/scripts/select.js.
// Pipelines pipe file paths (e.g. `rg --files -g '*.ts'`) into a file-cutting step, optionally through
// pipe steps that add computed context, and end with `present` (which renders context fields into `text`):
//
//   rg --files -g '*.{ts,tsx,js,py,go}' |
//     bun <skill>/scripts/select.js functions --flags --no-call-items |
//     bun <skill>/scripts/select.js present --no-lines
import { run as blame } from "./evals/steps/blame.ts"
import { run as comments } from "./evals/steps/comments.ts"
import { run as duplicates } from "./evals/steps/duplicates.ts"
import { run as enclosing } from "./evals/steps/enclosing.ts"
import { run as errorsGo } from "./evals/steps/errors-go.ts"
import { run as errors } from "./evals/steps/errors.ts"
import { run as excerpts } from "./evals/steps/excerpts.ts"
import { run as fileRole } from "./evals/steps/file-role.ts"
import { run as functions } from "./evals/steps/functions.ts"
import { run as literals } from "./evals/steps/literals.ts"
import { run as moduleExports } from "./evals/steps/module-exports.ts"
import { run as moduleOutline } from "./evals/steps/module-outline.ts"
import { run as moduleState } from "./evals/steps/module-state.ts"
import { run as present } from "./evals/steps/present.ts"
import { run as tests } from "./evals/steps/tests.ts"
import { run as wholeFile } from "./evals/steps/whole-file.ts"

const steps: Readonly<Record<string, (args: ReadonlyArray<string>) => Promise<void>>> = {
  functions,
  comments,
  errors,
  "errors-go": errorsGo,
  literals,
  "module-exports": moduleExports,
  "module-state": moduleState,
  "module-outline": moduleOutline,
  tests,
  duplicates,
  excerpts,
  "whole-file": wholeFile,
  "file-role": fileRole,
  enclosing,
  blame,
  present
}

const help = `usage: bun select.js <step> [options]

File cutters (read file paths on stdin, one per line; emit JSONL items):
  functions [flags]   TS/JS/Py/Go functions & methods (requires ast-grep)
                      flags: --min-lines N  --chunk N  --outer  --named  --module
                             --flags  --no-call-items  --classes N  --globals
                             --context  --docs  --hidden  --names  --effects
  comments            contiguous comment blocks with up to 8 lines of following code
  errors              TS/JS/Py/Go error handlers + handled code + facts (ast-grep)
  errors-go           Go statements that may drop an error (ast-grep)
  literals            un-named magic numbers/strings + elsewhere uses (ast-grep)
  module-exports      public declarations + in-file references + module summary
  module-state        classes/structs with mutable fields & exposure facts
  module-outline      file outline: imports, top-level declarations, members
  tests <names|behavior>
                      test units for naming or behavior-vs-implementation rules (ast-grep)
  duplicates          candidate pairs of similar/repeated blocks in a file
  excerpts [bytes]    consecutive excerpts of at most bytes (default: 1000)
  whole-file          one item per non-empty file

Pipe steps (read JSONL items on stdin; emit JSONL items):
  file-role           attach compact \`file role\` hints (test, wiring, utility, DTO)
  enclosing           attach \`enclosing\` block around each item's lines
  blame [YYYY-MM-DD]  attach \`changed\` git-blame date and age in days (default: today)
  present [--no-lines]
                      render location & context fields into \`text\` (final step);
                      pass --no-lines to omit line numbers from \`text\` for cache hits

Example:
  rg --files -g '*.{ts,tsx,js,py,go}' |
    bun select.js functions --flags --no-call-items |
    bun select.js file-role |
    bun select.js present --no-lines`

const [step, ...args] = Bun.argv.slice(2)
if (step === undefined || step === "--help" || step === "-h" || step === "help") {
  console.log(help)
  process.exit(0)
}
const runner = steps[step]
if (runner === undefined) {
  console.error(`select.js: unknown step ${JSON.stringify(step)} (run with --help to list steps)`)
  process.exit(2)
}
await runner(args)

// Compares Clef's quality under each rule-wording set in corpus/wordings against the polished corpus
// policies, on the same items: a reworded policy keeps the corpus policy's frontmatter, so both sides run
// the same selectors on the same file cases (the files labeled for that set, the policies it rewords) and
// differ only in rule text. Each side is scored against its own gold (polished gold for polished text, the
// set's gold for its text): at file level (a case's highest item score) and per item.
//   bun evals/wordings.ts [--split dev|test|all] [--origin all|real|planted|synthetic] [--concurrency 8] [set ...]
import { makeClient } from "./client.ts"
import { type Case, type Corpus, loadCorpus, loadWordings } from "./corpus.ts"
import { auroc, cliThresholds, type Label, pairedInterval, quality, type Scored } from "../src/score.ts"
import { corpusSelectorSet, fileScores, type ItemCase, productionPlan, scoreItems, selectItems } from "./selected.ts"

const args = Bun.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (value === undefined) throw new Error(`${name} needs a value`)
  args.splice(index, 2)
  return value
}
const split = flag("--split", "all")
const origin = flag("--origin", "all")
const concurrency = Number(flag("--concurrency", "8"))
if (!["dev", "test", "all"].includes(split)) throw new Error("--split must be dev, test, or all")
if (!["all", "real", "planted", "synthetic"].includes(origin)) throw new Error("--origin must be all, real, planted, or synthetic")
const wordings = await loadWordings()
const sets = args.length > 0 ? args : [...wordings.keys()]
for (const set of sets) if (!wordings.has(set)) throw new Error(`no wording set ${set}`)

const ask = makeClient(concurrency)
const polished = await loadCorpus()
const fixed = (value: number) => (Number.isNaN(value) ? "–" : value.toFixed(3))
const percent = (value: number) => (Number.isNaN(value) ? "–" : `${(value * 100).toFixed(1)}%`)
const signed = (value: number) => (Number.isNaN(value) ? "–" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}`)
const clear = (cases: ReadonlyArray<Scored<Case>>, label: Label) => cases.filter((scored) => scored.label === label).length
const clearItems = (scored: ReadonlyArray<Scored<ItemCase>>) => scored.filter((entry) => entry.label !== "ambiguous")

/** Judges `cases` through their policies' selectors; returns file case scores, item scores, and requests. */
const judge = async (corpus: Corpus, cases: ReadonlyArray<Case>) => {
  const scoped = { ...corpus, cases }
  const { fileCases, items } = await selectItems(scoped, split, corpusSelectorSet(scoped), { ambiguous: true })
  const run = await scoreItems(ask, items, productionPlan)
  return { files: fileScores(fileCases, run.scored), items: clearItems(run.scored), requests: run.requests }
}

const rows: Array<string> = []
const perPolicy: Array<string> = []
for (const set of sets) {
  const reworded = new Set(wordings.get(set)!.map((policy) => policy.name))
  const corpus = await loadCorpus({ wording: set })
  const keep = (item: Case) => reworded.has(item.policy.name) && (split === "all" || item.file.split === split) &&
    (origin === "all" || item.file.origin === origin)
  const theirs = corpus.cases.filter(keep)
  const ids = new Set(theirs.map((item) => item.id))
  const ours = polished.cases.filter((item) => ids.has(item.id))
  const [base, candidate] = await Promise.all([judge(polished, ours), judge(corpus, theirs)])
  const q0 = quality(base.files, cliThresholds)
  const q1 = quality(candidate.files, cliThresholds)
  const [low, high] = pairedInterval(base.files, candidate.files, auroc)
  const files = new Set(theirs.map((item) => item.file.id)).size
  rows.push(`| ${set} | ${reworded.size} | ${files} | ${clear(base.files, "violates")} → ${clear(candidate.files, "violates")} | ` +
    `${clear(base.files, "ambiguous")} → ${clear(candidate.files, "ambiguous")} | ${fixed(q0.auroc)} → ${fixed(q1.auroc)} ` +
    `[${signed(low)}, ${signed(high)}] | ${fixed(auroc(base.items))} → ${fixed(auroc(candidate.items))} | ` +
    `${percent(q0.falseAlarms)} → ${percent(q1.falseAlarms)} | ${percent(q0.caught)} → ${percent(q1.caught)} | ` +
    `${base.requests + candidate.requests} |`)
  for (const name of [...reworded].sort()) {
    const of = <A extends Case>(scored: ReadonlyArray<Scored<A>>) => scored.filter((entry) => entry.subject.policy.name === name)
    const [a, b] = [of(base.files), of(candidate.files)]
    perPolicy.push(`| ${set} | ${name} | ${clear(a, "violates")} → ${clear(b, "violates")} | ${fixed(auroc(a))} → ${fixed(auroc(b))} | ` +
      `${fixed(auroc(of(base.items)))} → ${fixed(auroc(of(candidate.items)))} | ` +
      `${percent(quality(a, cliThresholds).falseAlarms)} → ${percent(quality(b, cliThresholds).falseAlarms)} |`)
  }
}

console.log(`\nWording sets vs polished policies, split ${split}, origin ${origin}, production request shape, the corpus ` +
  `selectors' items. Each side is scored against gold labeled for its own text. Interval: 95% paired bootstrap of ` +
  `the file AUROC difference, resampling files.\n`)
console.log("| Set | Policies | Files | Clear violations (polished → set) | Ambiguous | File AUROC (clear) | Item AUROC | False alarms | Caught | Requests |")
console.log("|---|---|---|---|---|---|---|---|---|---|")
console.log(rows.join("\n"))
console.log("\n| Set | Policy | Clear violations (n) | File AUROC | Item AUROC | False alarms |")
console.log("|---|---|---|---|---|---|")
console.log(perPolicy.join("\n"))

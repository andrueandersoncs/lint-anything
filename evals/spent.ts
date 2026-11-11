// What re-using one test split to adopt policy candidates costs (RESEARCH.md, H25). A tuning agent scores a
// candidate with the skill's score script and adopts it when test improves outside noise. Here no candidate
// is better than the current policy: each labeled file's score is drawn at random from its stored scores
// under three strategies, so every version of a policy is as good as every other and any adoption is false.
//   Loop A: candidates checked one after another on the same test files, each adopted when it passes.
//   Loop B: candidates compared on dev files, only the best one checked on test.
// Reads stored results in evals/results/{dev,test}.real.semantic; sends no requests.
//   bun evals/spent.ts [--runs 400] [--seed 1] [--sizes 5,10,20,40] [--looks 1,3,5,10,20]
import { auroc, caught, falseAlarms, pairedInterval, type Scored } from "../src/score.ts"
import { defaultThreshold, reviewFloor } from "../src/lint.ts"

const args = Bun.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (value === undefined) throw new Error(`${name} needs a value`)
  args.splice(index, 2)
  return value
}
const runs = Number(flag("--runs", "400"))
const seed = Number(flag("--seed", "1"))
const sizes = flag("--sizes", "5,10,20,40").split(",").map(Number)
const looks = flag("--looks", "1,3,5,10,20").split(",").map(Number)
if (args.length > 0) throw new Error(`unknown arguments: ${args.join(" ")}`)
const maxLooks = Math.max(...looks)

const strategies = ["production", "production,chunk=0", "production,shape=file,chunk=4000"]

/** A labeled file case with its score under each strategy. */
interface Target {
  readonly key: string
  readonly policy: string
  readonly label: "violates" | "complies"
  readonly scores: ReadonlyArray<number | null>
}

const targets: Array<Target> = []
for (const split of ["dev", "test"]) {
  const byStrategy = await Promise.all(strategies.map(async (strategy) => {
    const text = await Bun.file(`${import.meta.dir}/results/${split}.real.semantic/${strategy}.jsonl`).text()
    const rows = text.trim().split("\n").map((line) => JSON.parse(line) as { case: string; label: string; score: number | null })
    return new Map(rows.map((row) => [row.case, row]))
  }))
  for (const [key, row] of byStrategy[0]!) {
    if (row.label !== "violates" && row.label !== "complies") continue
    const others = byStrategy.map((rows) => rows.get(key))
    if (others.some((other) => other === undefined || other.label !== row.label)) throw new Error(`${split} ${key}: strategies disagree`)
    targets.push({ key: `${split}:${key}`, policy: key.slice(key.indexOf(":") + 1), label: row.label, scores: others.map((other) => other!.score) })
  }
}
const pools = new Map<string, { violates: Array<Target>; complies: Array<Target> }>()
for (const target of targets) {
  const pool = pools.get(target.policy) ?? { violates: [], complies: [] }
  pool[target.label].push(target)
  pools.set(target.policy, pool)
}

// The skill's caught and false alarms at the CLI's cut-offs, without computing every other metric per resample.
const fastCaught = (cases: ReadonlyArray<Scored<unknown>>) => {
  const violating = cases.filter((scored) => scored.label === "violates")
  return violating.length === 0 ? Number.NaN : violating.filter((scored) => (scored.score ?? 0) >= defaultThreshold).length / violating.length
}
const fastFalseAlarms = (cases: ReadonlyArray<Scored<unknown>>) => {
  const clean = cases.filter((scored) => scored.label === "complies")
  return clean.length === 0 ? Number.NaN : clean.filter((scored) => (scored.score ?? 0) > reviewFloor).length / clean.length
}

// Deterministic PRNG, so a seed reproduces a run.
const mulberry32 = (state: number) => () => {
  state = (state + 0x6d2b79f5) | 0
  let t = Math.imul(state ^ (state >>> 15), 1 | state)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const random = mulberry32(seed)
const pick = <A>(values: ReadonlyArray<A>) => values[Math.floor(random() * values.length)]!

/** Disjoint samples of `size` from `pool`, one per entry of `count`. */
const disjoint = <A>(pool: ReadonlyArray<A>, size: number, count: number) => {
  const shuffled = [...pool]
  for (let index = 0; index < size * count; index++) {
    const swap = index + Math.floor(random() * (shuffled.length - index))
    ;[shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!]
  }
  return Array.from({ length: count }, (_, part) => shuffled.slice(part * size, (part + 1) * size))
}

/** A version of the policy: each target's score under a strategy drawn at random once per version. */
const version = () => {
  const choice = new Map<Target, number>()
  return (sample: ReadonlyArray<Target>): Array<Scored<Target>> =>
    sample.map((target) => {
      if (!choice.has(target)) choice.set(target, Math.floor(random() * strategies.length))
      return { subject: target, label: target.label, group: target.key, score: target.scores[choice.get(target)!]! }
    })
}
type Version = ReturnType<typeof version>

// score.js's comparison and the skill's rule: adopt when one metric improves outside noise and none worsens.
const metrics = [
  { metric: auroc, higherIsBetter: true },
  { metric: fastCaught, higherIsBetter: true },
  { metric: fastFalseAlarms, higherIsBetter: false }
]
const adopts = (sample: ReadonlyArray<Target>, current: Version, candidate: Version) => {
  const [before, after] = [current(sample), candidate(sample)]
  let improves = false
  for (const { metric, higherIsBetter } of metrics) {
    const [low, high] = pairedInterval(before, after, metric)
    if (low <= 0 && 0 <= high) continue
    if ((low > 0) === higherIsBetter) improves = true
    else return false
  }
  return improves
}
const gain = (sample: ReadonlyArray<Target>, current: Version, candidate: Version) => auroc(candidate(sample)) - auroc(current(sample))

// The fast metrics must match src/score.ts.
for (const strategy of strategies.keys()) {
  const cases = targets.map((target) => ({ subject: target, label: target.label, group: target.key, score: target.scores[strategy]! }))
  if (fastCaught(cases) !== caught(cases) || fastFalseAlarms(cases) !== falseAlarms(cases)) throw new Error("fast metrics differ from src/score.ts")
}

const wilson = (hits: number, total: number) => {
  const z = 1.96
  const p = hits / total
  const center = (p + (z * z) / (2 * total)) / (1 + (z * z) / total)
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / (1 + (z * z) / total)
  return [Math.max(0, center - half), Math.min(1, center + half)] as const
}
const percent = (hits: number, total: number) => {
  const [low, high] = wilson(hits, total)
  return `${((100 * hits) / total).toFixed(1)}% [${(100 * low).toFixed(1)}, ${(100 * high).toFixed(1)}]`
}
const mean = (values: ReadonlyArray<number>) => values.reduce((sum, value) => sum + value, 0) / values.length
const signed = (value: number) => (Number.isNaN(value) ? "–" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}`)

console.log(`${targets.length} file cases, ${pools.size} policies; ${runs} runs per size; seed ${seed}.\n`)
const header = `| files per class | policies | ${looks.map((k) => `K = ${k}`).join(" | ")} |`
const rule = `|---|---|${looks.map(() => "---").join("|")}|`
const tableA = [header, rule]
const tableB = [header, rule]
const curse = ["| files per class | adoptions | test AUROC gain at adoption | same candidate on fresh files |", "|---|---|---|---|"]
for (const size of sizes) {
  const eligible = [...pools.entries()].filter(([, pool]) => pool.violates.length >= 2 * size && pool.complies.length >= 2 * size)
  if (eligible.length === 0) continue
  const firstAdoption: Array<number> = []
  const adoptedB = looks.map(() => 0)
  const reported: Array<number> = []
  const fresh: Array<number> = []
  const started = performance.now()
  for (let run = 0; run < runs; run++) {
    const [, pool] = pick(eligible)
    const [violatingA, violatingB] = disjoint(pool.violates, size, 2)
    const [cleanA, cleanB] = disjoint(pool.complies, size, 2)
    const test = [...violatingA!, ...cleanA!]
    const other = [...violatingB!, ...cleanB!]
    // Loop A: on the same test files until a candidate is adopted; `other` is the fresh files.
    let current = version()
    let first = Number.POSITIVE_INFINITY
    for (let look = 1; look <= maxLooks; look++) {
      const candidate = version()
      if (adopts(test, current, candidate)) {
        first = look
        reported.push(gain(test, current, candidate))
        fresh.push(gain(other, current, candidate))
        break
      }
    }
    firstAdoption.push(first)
    // Loop B: `other` is dev; the candidate with the best dev AUROC gain is checked once on test.
    current = version()
    const candidates = Array.from({ length: maxLooks }, () => version())
    const devGains = candidates.map((candidate) => gain(other, current, candidate))
    for (const [index, k] of looks.entries()) {
      let best = 0
      for (let i = 1; i < k; i++) if (devGains[i]! > devGains[best]!) best = i
      if (adopts(test, current, candidates[best]!)) adoptedB[index]!++
    }
  }
  const policies = eligible.length
  tableA.push(`| ${size} + ${size} | ${policies} | ${looks.map((k) => percent(firstAdoption.filter((first) => first <= k).length, runs)).join(" | ")} |`)
  tableB.push(`| ${size} + ${size} | ${policies} | ${adoptedB.map((hits) => percent(hits, runs)).join(" | ")} |`)
  curse.push(`| ${size} + ${size} | ${reported.length} | ${signed(mean(reported))} | ${signed(mean(fresh))} |`)
  console.error(`size ${size}: ${((performance.now() - started) / 1000).toFixed(0)} s`)
}
console.log("Loop A, every candidate checked on the same test files: runs that adopt a no-better candidate within K candidates [95%]")
console.log(tableA.join("\n"))
console.log("\nLoop B, candidates compared on dev, the best checked once on test: runs that adopt it [95%]")
console.log(tableB.join("\n"))
console.log("\nLoop A at its first adoption: mean AUROC gain on the test files that adopted it, and on fresh files")
console.log(curse.join("\n"))

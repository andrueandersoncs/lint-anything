// Checks the corpus and prints label counts per policy and origin.
//   bun evals/validate.ts [--require-splits] [--verify-upstream]
// --verify-upstream fetches every real file from GitHub at its pinned commit and compares bytes.
import { loadCorpus, verifyUpstream } from "./corpus.ts"

const corpus = await loadCorpus({ requireSplits: Bun.argv.includes("--require-splits") })
if (Bun.argv.includes("--verify-upstream")) {
  const problems = await verifyUpstream(corpus.files)
  if (problems.length > 0) throw new Error(`upstream mismatches:\n${problems.join("\n")}`)
  console.log(`${corpus.files.filter((file) => file.origin === "real").length} real files match upstream`)
}
const origins = ["synthetic", "real", "planted"] as const
const rows = corpus.policies.map((policy) => {
  const counts = origins.map((origin) => {
    const cases = corpus.cases.filter((item) => item.policy.name === policy.name && item.file.origin === origin)
    const violating = cases.filter((item) => item.gold.label === "violates").length
    return `${origin} ${violating}/${cases.length}`.padEnd(16)
  })
  return `${policy.name.padEnd(36)} violating/cases: ${counts.join(" ")}`
})
console.log(rows.join("\n"))
for (const origin of origins) {
  const cases = corpus.cases.filter((item) => item.file.origin === origin)
  console.log(`${origin}: ${corpus.files.filter((file) => file.origin === origin).length} files, ${cases.length} cases, ` +
    `${cases.filter((item) => item.gold.label === "violates").length} violating`)
}

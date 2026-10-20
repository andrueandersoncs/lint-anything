// Checks the corpus and prints label counts per policy: `bun evals/validate.ts [--require-splits]`.
import { loadCorpus } from "./corpus.ts"

const corpus = await loadCorpus({ requireSplits: Bun.argv.includes("--require-splits") })
const rows = corpus.policies.map((policy) => {
  const cases = corpus.cases.filter((item) => item.policy.name === policy.name)
  const count = (label: string) => cases.filter((item) => item.gold.label === label).length
  return `${policy.name.padEnd(36)} ${String(cases.length).padStart(4)} cases  ${count("violates")} violates  ${count("complies")} complies  ${count("not-applicable")} n/a`
})
console.log(rows.join("\n"))
console.log(`${corpus.files.length} files, ${corpus.cases.length} cases`)

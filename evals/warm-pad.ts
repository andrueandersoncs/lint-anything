// Tests the warm-cache single-item cliff (H24 showed `single` loses -0.021 Item AUROC on Clef when an edit
// leaves only 1 cache miss) and whether padding a 1-item request with 4 fixed policy anchors recovers
// packed accuracy on Clef. Runs on a stratified sample of dev real semantic items (cheap: ~300 requests).
//   bun evals/warm-pad.ts [--concurrency 8]
import { planRequests, type Question } from "../src/decision-model.ts"
import { itemQuestion } from "../src/lint.ts"
import { auprc, auroc, brier, cliThresholds, pairedInterval, type Scored, violationPrecision } from "../src/score.ts"
import { makeClient, model } from "./client.ts"
import { loadCorpus, scoreLabel } from "./corpus.ts"
import { corpusSelectorSet, type ItemCase, productionPlan, scoreItems, selectItems } from "./selected.ts"

const args = Bun.argv.slice(2)
const concurrency = Number(args.includes("--concurrency") ? args[args.indexOf("--concurrency") + 1] : "8")

const anchorTexts: Record<string, ReadonlyArray<string>> = {
  "semantic/readability/comments-explain-why": [
    "location: retry.ts (lines 10-12)\n\nitem:\n// Jitter prevents thundering-herd retries when all workers wake after an outage.\nconst delay = baseMs * (0.5 + Math.random())",
    "location: api.ts (lines 1-4)\n\nitem:\n/** Computes the SHA-256 hex digest for a request payload. */\nexport function digestPayload(body: string): string {",
    "location: loop.ts (lines 15-16)\n\nitem:\n// Increment the counter by one\ncount += 1",
    "location: users.py (lines 22-23)\n\nitem:\n# Return the list of users\nreturn users"
  ],
  "semantic/design/single-responsibility": [
    "location: checkout.ts (lines 1-9)\n\nitem:\nexport async function completeOrder(req: Request) {\n  const order = parseOrder(req)\n  validateInventory(order)\n  const total = calculateTotal(order)\n  await saveOrder(order, total)\n  await sendConfirmation(order)\n}",
    "location: parser.ts (lines 1-10)\n\nitem:\nexport function parseCsvLine(line: string): string[] {\n  const fields: string[] = []\n  let cur = \"\", inQuote = false\n  for (const ch of line) {\n    if (ch === '\"') inQuote = !inQuote\n    else if (ch === ',' && !inQuote) { fields.push(cur); cur = \"\" }\n    else cur += ch\n  }\n  fields.push(cur)\n  return fields\n}",
    "location: billing.ts (lines 1-16)\n\nitem:\nexport async function handleInvoice(rawJson: string, db: Db, smtp: Mailer) {\n  const inv = JSON.parse(rawJson)\n  if (!inv.items?.length) throw new Error(\"empty\")\n  let total = 0\n  for (const it of inv.items) total += it.price * it.qty * (inv.vip ? 0.85 : 1)\n  if (total > 500) total -= 25\n  await db.exec(\"INSERT INTO invoices VALUES (?, ?)\", [inv.id, total])\n  const html = `<h1>Invoice #${inv.id}</h1><p>Due: $${total.toFixed(2)}</p>`\n  await smtp.send({ to: inv.email, subject: \"Invoice\", html })\n}",
    "location: report.py (lines 1-14)\n\nitem:\ndef process_users(path, conn, webhook_url):\n    rows = [line.split(\",\") for line in open(path)]\n    active = [r for r in rows if r[2] == \"active\" and int(r[3]) >= 18]\n    for r in active:\n        conn.execute(\"UPDATE users SET tier=? WHERE id=?\", (\"gold\" if int(r[4]) > 100 else \"std\", r[0]))\n    conn.commit()\n    summary = \"\\n\".join(f\"{r[1]}: {r[4]}\" for r in active)\n    requests.post(webhook_url, json={\"text\": summary})"
  ],
  "semantic/encapsulation/minimal-public-surface": [
    "location: string-utils.ts (lines 1-6)\n\nitem:\nexport function slugify(text: string): string {\n  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, \"-\")\n}",
    "location: handler.go (lines 1-5)\n\nitem:\n// Implements http.Handler\nfunc (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {\n  s.mux.ServeHTTP(w, r)\n}",
    "location: compiler.ts (lines 40-47)\n\nreferenced in this file: compile (line 12)\n\nitem:\nexport function normalizeAstPass2Internal(nodes: Node[]): Node[] {\n  return nodes.map((n) => ({ ...n, normalized: true }))\n}",
    "location: engine.go (lines 80-86)\n\nreferenced in this file: RunQuery (line 20)\n\nitem:\nfunc BuildIntermediateScanState(rows []Row) *scanState {\n  return &scanState{rows: rows, idx: 0}\n}"
  ]
}

const targetPolicies = new Set(Object.keys(anchorTexts))
const loaded = await loadCorpus({ requireSplits: true })
const cases = loaded.cases.filter((c) => c.file.split === "dev" && c.file.origin === "real" && targetPolicies.has(c.policy.name))
const corpus = { ...loaded, cases }
const { items } = await selectItems(corpus, "dev", corpusSelectorSet(corpus), { ambiguous: false })

const ask = makeClient(concurrency)
const packedRun = await scoreItems(ask, items, productionPlan)

// Stratified sample: up to 150 violating + 250 clean items (deterministic)
const viol = packedRun.scored.filter((x) => x.label === "violates")
const clean = packedRun.scored.filter((x) => x.label === "complies")
const stepV = Math.max(1, Math.floor(viol.length / 150))
const stepC = Math.max(1, Math.floor(clean.length / 250))
const sample = [
  ...viol.filter((_, i) => i % stepV === 0).slice(0, 150),
  ...clean.filter((_, i) => i % stepC === 0).slice(0, 250)
]

const byPolicy = new Map<string, Array<ItemCase>>()
for (const it of items) {
  const arr = byPolicy.get(it.policy.name) ?? []
  arr.push(it)
  byPolicy.set(it.policy.name, arr)
}

const scoreOne = async (item: ItemCase, mode: "single" | "anchors" | "siblings"): Promise<number | null> => {
  const q = itemQuestion(item.policy, item.entry)
  let prefix: Array<Question> = []
  if (mode === "anchors") {
    prefix = anchorTexts[item.policy.name]!.map((text) => ({ instructions: text, criteria: item.policy.criteria }))
  } else if (mode === "siblings") {
    // Pick up to 4 other items from the same policy (preferring same file, else evenly spaced across policy),
    // mimicking padding a 1-miss warm-cache batch with already-cached sibling items.
    const all = byPolicy.get(item.policy.name)!
    const sameFile = all.filter((other) => other !== item && other.file.id === item.file.id)
    const pool = sameFile.length >= 4 ? sameFile : [...sameFile, ...all.filter((other) => other !== item && other.file.id !== item.file.id)]
    const step = Math.max(1, Math.floor(pool.length / 4))
    prefix = pool.filter((_, idx) => idx % step === 0).slice(0, 4).map((other) => itemQuestion(item.policy, other.entry))
  }
  const questions = [...prefix, q]
  const planned = planRequests(item.policy.body, questions, model)
  if (planned.requests.length !== 1) return null
  const reply = await ask(planned.requests[0]!.body)
  const targetId = `i${prefix.length}`
  const ans = reply.answers.get(targetId)
  return ans === undefined || ans === "declined" ? null : ans
}

const singleScores = await Promise.all(sample.map((entry) => scoreOne(entry.subject, "single")))
const paddedScores = await Promise.all(sample.map((entry) => scoreOne(entry.subject, "anchors")))
const siblingScores = await Promise.all(sample.map((entry) => scoreOne(entry.subject, "siblings")))

const singleScored: Array<Scored<ItemCase>> = sample.map((entry, i) => ({ ...entry, score: singleScores[i]! }))
const paddedScored: Array<Scored<ItemCase>> = sample.map((entry, i) => ({ ...entry, score: paddedScores[i]! }))
const siblingScored: Array<Scored<ItemCase>> = sample.map((entry, i) => ({ ...entry, score: siblingScores[i]! }))

const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

console.log(`\nWarm-cache single-item cliff vs. 4-anchor / 4-sibling padding (${sample.length} dev items: ${sample.filter((x) => x.label === "violates").length} viol, ${sample.filter((x) => x.label === "complies").length} clean, ${model.name}):\n`)
console.log("| Mode | Item AUROC [vs Packed] | Item PR-AUC [vs Packed] | Item Brier | Item Prec(V) | Mean |Δ| vs Packed |")
console.log("|---|---|---|---|---|---|")
for (const [name, arr] of [
  ["Packed (baseline)", sample],
  ["Single (warm 1-miss)", singleScored],
  ["Single + 4 cached siblings", siblingScored],
  ["Single + 4 fixed anchors", paddedScored]
] as const) {
  const aCi = name.startsWith("Packed") ? "" : ` [${pairedInterval(sample, arr, auroc).map(signed).join(", ")}]`
  const pCi = name.startsWith("Packed") ? "" : ` [${pairedInterval(sample, arr, auprc).map(signed).join(", ")}]`
  const meanDelta = sample.reduce((s, x, i) => s + Math.abs((x.score ?? 0) - (arr[i]!.score ?? 0)), 0) / sample.length
  console.log(`| ${name} | ${auroc(arr).toFixed(3)}${aCi} | ${auprc(arr).toFixed(3)}${pCi} | ${brier(arr).toFixed(3)} | ${pct(violationPrecision(arr, cliThresholds))} | ${meanDelta.toFixed(4)} |`)
}

// H30: In-batch contrastive calibration anchors.
// Packs 4 fixed, synthetic near-boundary anchor items (2 clean exemption traps + 2 clear violations) as
// actual questions inside every policy request, and tests two effects on dev real semantic (6 policies
// spanning low-scale and high-scale rules):
//   1. Raw in-batch anchor effect (do fixed anchors stabilize Clef, including on 1-item warm-cache requests?)
//   2. Self-calibrating logit alignment: centers each policy's logits using the model's own scores on its
//      clean-trap vs. violating anchors, aligning both across policies and across models (Clef & Gemini)
//      without any repo-specific labeled files.
//   bun evals/anchors.ts [--concurrency 8]
import { planRequests, type Question } from "../src/decision-model.ts"
import { itemQuestion } from "../src/lint.ts"
import {
  auprc,
  auroc,
  brier,
  cliThresholds,
  pairedInterval,
  quality,
  type Scored,
  tprAtFpr,
  violationPrecision
} from "../src/score.ts"
import { makeClient, model } from "./client.ts"
import { type Case, loadCorpus, scoreLabel } from "./corpus.ts"
import { corpusSelectorSet, costPerThousand, fileScores, type ItemCase, productionPlan, scoreItems, selectItems } from "./selected.ts"

const args = Bun.argv.slice(2)
const concurrency = Number(args.includes("--concurrency") ? args[args.indexOf("--concurrency") + 1] : "8")

interface Anchor {
  readonly label: "clean" | "violates"
  readonly text: string
}

// Synthetic, self-contained, near-boundary anchors written directly from each rule's text (zero corpus overlap).
const anchorsByPolicy: Record<string, ReadonlyArray<Anchor>> = {
  "semantic/design/single-responsibility": [
    {
      label: "clean",
      text: "location: checkout.ts (lines 1-9)\n\nitem:\nexport async function completeOrder(req: Request) {\n  const order = parseOrder(req)\n  validateInventory(order)\n  const total = calculateTotal(order)\n  await saveOrder(order, total)\n  await sendConfirmation(order)\n}"
    },
    {
      label: "clean",
      text: "location: parser.ts (lines 1-10)\n\nitem:\nexport function parseCsvLine(line: string): string[] {\n  const fields: string[] = []\n  let cur = \"\", inQuote = false\n  for (const ch of line) {\n    if (ch === '\"') inQuote = !inQuote\n    else if (ch === ',' && !inQuote) { fields.push(cur); cur = \"\" }\n    else cur += ch\n  }\n  fields.push(cur)\n  return fields\n}"
    },
    {
      label: "violates",
      text: "location: billing.ts (lines 1-16)\n\nitem:\nexport async function handleInvoice(rawJson: string, db: Db, smtp: Mailer) {\n  const inv = JSON.parse(rawJson)\n  if (!inv.items?.length) throw new Error(\"empty\")\n  let total = 0\n  for (const it of inv.items) total += it.price * it.qty * (inv.vip ? 0.85 : 1)\n  if (total > 500) total -= 25\n  await db.exec(\"INSERT INTO invoices VALUES (?, ?)\", [inv.id, total])\n  const html = `<h1>Invoice #${inv.id}</h1><p>Due: $${total.toFixed(2)}</p>`\n  await smtp.send({ to: inv.email, subject: \"Invoice\", html })\n}"
    },
    {
      label: "violates",
      text: "location: report.py (lines 1-14)\n\nitem:\ndef process_users(path, conn, webhook_url):\n    rows = [line.split(\",\") for line in open(path)]\n    active = [r for r in rows if r[2] == \"active\" and int(r[3]) >= 18]\n    for r in active:\n        conn.execute(\"UPDATE users SET tier=? WHERE id=?\", (\"gold\" if int(r[4]) > 100 else \"std\", r[0]))\n    conn.commit()\n    summary = \"\\n\".join(f\"{r[1]}: {r[4]}\" for r in active)\n    requests.post(webhook_url, json={\"text\": summary})"
    }
  ],
  "semantic/encapsulation/minimal-public-surface": [
    {
      label: "clean",
      text: "location: string-utils.ts (lines 1-6)\n\nitem:\nexport function slugify(text: string): string {\n  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, \"-\")\n}"
    },
    {
      label: "clean",
      text: "location: handler.go (lines 1-5)\n\nitem:\n// Implements http.Handler\nfunc (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {\n  s.mux.ServeHTTP(w, r)\n}"
    },
    {
      label: "violates",
      text: "location: compiler.ts (lines 40-47)\n\nreferenced in this file: compile (line 12)\n\nitem:\nexport function normalizeAstPass2Internal(nodes: Node[]): Node[] {\n  return nodes.map((n) => ({ ...n, normalized: true }))\n}"
    },
    {
      label: "violates",
      text: "location: engine.go (lines 80-86)\n\nreferenced in this file: RunQuery (line 20)\n\nitem:\nfunc BuildIntermediateScanState(rows []Row) *scanState {\n  return &scanState{rows: rows, idx: 0}\n}"
    }
  ],
  "semantic/readability/comments-explain-why": [
    {
      label: "clean",
      text: "location: retry.ts (lines 10-12)\n\nitem:\n// Jitter prevents thundering-herd retries when all workers wake after an outage.\nconst delay = baseMs * (0.5 + Math.random())"
    },
    {
      label: "clean",
      text: "location: api.ts (lines 1-4)\n\nitem:\n/** Computes the SHA-256 hex digest for a request payload. */\nexport function digestPayload(body: string): string {"
    },
    {
      label: "violates",
      text: "location: loop.ts (lines 15-16)\n\nitem:\n// Increment the counter by one\ncount += 1"
    },
    {
      label: "violates",
      text: "location: users.py (lines 22-23)\n\nitem:\n# Return the list of users\nreturn users"
    }
  ],
  "semantic/design/no-flag-parameters": [
    {
      label: "clean",
      text: "location: button.ts (lines 1-4)\n\nboolean parameters: enabled (positional)\n\nitem:\nexport function setEnabled(btn: Button, enabled: boolean) {\n  btn.enabled = enabled\n}"
    },
    {
      label: "clean",
      text: "location: fetch.ts (lines 1-5)\n\nboolean parameters: opts.includeDeleted (options)\n\nitem:\nexport function fetchUsers(opts: { includeDeleted?: boolean }) {\n  return opts.includeDeleted ? db.allUsers() : db.activeUsers()\n}"
    },
    {
      label: "violates",
      text: "location: render.ts (lines 1-7)\n\nboolean parameters: isPreview (positional)\n\nitem:\nexport function renderDocument(doc: Doc, isPreview: boolean) {\n  if (isPreview) return renderWatermarkHtml(doc)\n  return exportProductionPdf(doc)\n}"
    },
    {
      label: "violates",
      text: "location: sync.go (lines 1-8)\n\nboolean parameters: dryRun (positional), force (positional)\n\nitem:\nfunc syncRecords(records []Record, dryRun bool, force bool) error {\n  if dryRun { return printDiff(records) }\n  if force { return overwriteAll(records) }\n  return mergeRecords(records)\n}"
    }
  ],
  "semantic/architecture/separate-decisions-from-effects": [
    {
      label: "clean",
      text: "location: service.ts (lines 1-7)\n\nitem:\nexport async function applyDiscount(userId: string) {\n  const user = await db.getUser(userId)\n  const discount = computeEligibleDiscount(user)\n  await db.saveDiscount(userId, discount)\n}"
    },
    {
      label: "clean",
      text: "location: pricing.ts (lines 1-6)\n\nitem:\nexport function computeEligibleDiscount(user: User): number {\n  if (user.plan === \"enterprise\" && user.seats > 50) return 0.2\n  return user.yearsActive >= 3 ? 0.1 : 0\n}"
    },
    {
      label: "violates",
      text: "location: billing.ts (lines 1-14)\n\nitem:\nexport async function renewSubscription(userId: string) {\n  const user = await db.getUser(userId)\n  const invoices = await db.getUnpaidInvoices(userId)\n  let rate = user.tier === \"pro\" ? 49 : 19\n  if (invoices.length === 0 && user.tenureMonths > 12) rate *= 0.85\n  if (user.country === \"EU\" && !user.vatId) rate *= 1.2\n  await stripe.charge(user.cardId, rate)\n  await mailer.send(user.email, `Charged ${rate}`)\n}"
    },
    {
      label: "violates",
      text: "location: access.py (lines 1-12)\n\nitem:\ndef grant_or_revoke(user_id, db, audit_api):\n    u = db.fetch_user(user_id)\n    score = u.violations * 3 + (5 if u.unverified else 0)\n    if score >= 10 and not u.is_admin:\n        db.execute(\"UPDATE users SET status='suspended' WHERE id=?\", (user_id,))\n        audit_api.post({\"user\": user_id, \"action\": \"suspend\"})\n    else:\n        db.execute(\"UPDATE users SET status='active' WHERE id=?\", (user_id,))"
    }
  ],
  "semantic/testing/test-behavior-not-implementation": [
    {
      label: "clean",
      text: "location: auth.test.ts (lines 1-8)\n\nitem:\ntest(\"rejects expired token\", async () => {\n  const clock = fakeClock(\"2026-01-02\")\n  const auth = new AuthService(clock)\n  await expect(auth.verify(expiredToken)).rejects.toThrow(\"expired\")\n})"
    },
    {
      label: "clean",
      text: "location: repo.test.ts (lines 1-7)\n\nitem:\ntest(\"returns cached user without second HTTP call\", async () => {\n  const fetchSpy = spyOn(httpClient, \"get\").mockResolvedValue(userJson)\n  expect(await service.getUser(\"1\")).toEqual(user)\n  expect(await service.getUser(\"1\")).toEqual(user)\n  expect(fetchSpy).toHaveBeenCalledTimes(1)\n})"
    },
    {
      label: "violates",
      text: "location: parser.test.ts (lines 1-7)\n\nitem:\ntest(\"parses input\", () => {\n  const p = new Parser()\n  const spy = spyOn(p as any, \"_tokenizeInternal\")\n  p.parse(\"a + b\")\n  expect(spy).toHaveBeenCalledTimes(1)\n  expect((p as any)._bufferIndex).toBe(5)\n})"
    },
    {
      label: "violates",
      text: "location: cache.test.py (lines 1-8)\n\nitem:\ndef test_eviction():\n    c = LruCache(2)\n    c.put(\"a\", 1)\n    assert c._internal_deque[0] == \"a\"\n    assert len(c._backing_dict) == 1"
    }
  ]
}

const targetNames = new Set(Object.keys(anchorsByPolicy))
const loaded = await loadCorpus({ requireSplits: true })
const cases = loaded.cases.filter((c) => c.file.split === "dev" && c.file.origin === "real" && targetNames.has(c.policy.name))
const corpus = { ...loaded, cases }
const set = corpusSelectorSet(corpus)
const { fileCases, items } = await selectItems(corpus, "dev", set, { ambiguous: true })
const fileCount = new Set(cases.map((c) => c.file.id)).size

const ask = makeClient(concurrency)

// 1. Baseline (cached)
const baseRun = await scoreItems(ask, items, productionPlan)
const baseFiles = fileScores(fileCases, baseRun.scored)
const baseTokens = [...baseRun.inputTokens.values()].reduce((a, b) => a + b, 0)

// 2. Anchor-packed run: prepend the 4 policy anchors to every packed request!
const groups = new Map<string, Array<ItemCase>>()
for (const item of items) {
  const key = `${item.file.id}\0${item.policy.name}`
  const list = groups.get(key)
  if (list === undefined) groups.set(key, [item])
  else list.push(item)
}

const rawAnchorScores = new Map<ItemCase, number | null>()
const batchAnchorCalScores = new Map<ItemCase, number | null>()
const policyAnchorClean = new Map<string, Array<number>>()
const policyAnchorViol = new Map<string, Array<number>>()
let ancRequests = 0
let ancTokens = 0

const clip = (p: number) => Math.min(0.995, Math.max(0.005, p))
const logit = (p: number) => Math.log(clip(p) / (1 - clip(p)))
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

await Promise.all([...groups.values()].map(async (group) => {
  const policy = group[0]!.policy
  const anchors = anchorsByPolicy[policy.name]!
  const anchorQuestions: Array<Question> = anchors.map((a) => ({ instructions: a.text, criteria: policy.criteria }))
  // Chunk real items up to 60 per batch so 4 anchors always fit inside the 64-question limit.
  for (let start = 0; start < group.length; start += 60) {
    const slice = group.slice(start, start + 60)
    const questions: Array<Question> = [...anchorQuestions, ...slice.map((it) => itemQuestion(policy, it.entry))]
    const planned = planRequests(policy.body, questions, model)
    for (const { value } of planned.oversized) {
      if (value >= anchors.length) {
        const it = slice[value - anchors.length]!
        rawAnchorScores.set(it, null)
        batchAnchorCalScores.set(it, null)
      }
    }
    await Promise.all(planned.requests.map(async (req) => {
      const reply = await ask(req.body)
      ancRequests++
      ancTokens += reply.inputTokens
      const cleanLogits: Array<number> = []
      const violLogits: Array<number> = []
      const itemAnswers: Array<{ item: ItemCase; score: number | null }> = []
      for (const { id, value } of req.questions) {
        const ans = reply.answers.get(id)
        if (ans === undefined) throw new Error(`missing answer ${id}`)
        const num = ans === "declined" ? null : ans
        if (value < anchors.length) {
          if (num !== null) {
            const label = anchors[value]!.label
            if (label === "clean") {
              cleanLogits.push(logit(num))
              const arr = policyAnchorClean.get(policy.name) ?? []
              arr.push(logit(num))
              policyAnchorClean.set(policy.name, arr)
            } else {
              violLogits.push(logit(num))
              const arr = policyAnchorViol.get(policy.name) ?? []
              arr.push(logit(num))
              policyAnchorViol.set(policy.name, arr)
            }
          }
        } else {
          itemAnswers.push({ item: slice[value - anchors.length]!, score: num })
        }
      }
      const mean = (arr: ReadonlyArray<number>) => arr.reduce((a, b) => a + b, 0) / arr.length
      const hasBoth = cleanLogits.length > 0 && violLogits.length > 0
      const midpoint = hasBoth ? (mean(cleanLogits) + mean(violLogits)) / 2 : 0
      for (const { item, score } of itemAnswers) {
        rawAnchorScores.set(item, score)
        batchAnchorCalScores.set(item, score === null ? null : sigmoid(logit(score) - midpoint))
      }
    }))
  }
}))

// Policy-level midpoint calibration (averages the anchor scores across all batches of the policy, zero variance)
const mean = (arr: ReadonlyArray<number>) => arr.reduce((a, b) => a + b, 0) / arr.length
const policyMidpoint = new Map<string, number>()
console.log(`\nAnchor diagnostics per policy (${model.name}):`)
for (const name of targetNames) {
  const cArr = policyAnchorClean.get(name) ?? [0]
  const vArr = policyAnchorViol.get(name) ?? [0]
  const cMean = mean(cArr)
  const vMean = mean(vArr)
  const mid = (cMean + vMean) / 2
  policyMidpoint.set(name, mid)
  console.log(`  ${name.replace("semantic/", "").padEnd(42)} cleanAnchor=${sigmoid(cMean).toFixed(3)} violAnchor=${sigmoid(vMean).toFixed(3)} midpointLogit=${mid >= 0 ? "+" : ""}${mid.toFixed(3)}`)
}

const toScored = (fn: (it: ItemCase) => number | null): Array<Scored<ItemCase>> =>
  items.map((item) => ({ subject: item, label: scoreLabel(item.gold.label), group: item.file.id, score: fn(item) }))

const rawItems = toScored((it) => rawAnchorScores.get(it) ?? null)
const batchCalItems = toScored((it) => batchAnchorCalScores.get(it) ?? null)
const policyCalItems = toScored((it) => {
  const s = rawAnchorScores.get(it)
  if (s === null || s === undefined) return null
  return sigmoid(logit(s) - (policyMidpoint.get(it.policy.name) ?? 0))
})
// Also apply policy-level anchor midpoint directly to BASELINE scores (anchor probe once per policy -> 0 per-batch overhead!)
const probeCalItems = baseRun.scored.map((entry) => ({
  ...entry,
  score: entry.score === null ? null : sigmoid(logit(entry.score) - (policyMidpoint.get(entry.subject.policy.name) ?? 0))
}))

const rawFiles = fileScores(fileCases, rawItems)
const batchCalFiles = fileScores(fileCases, batchCalItems)
const policyCalFiles = fileScores(fileCases, policyCalItems)
const probeCalFiles = fileScores(fileCases, probeCalItems)

const clear = <A>(arr: ReadonlyArray<Scored<A>>) => arr.filter((x) => x.label !== "ambiguous")
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

const reportRow = (name: string, files: ReadonlyArray<Scored<Case>>, scoredItems: ReadonlyArray<Scored<ItemCase>>, reqs: number, tokens: number, isBase: boolean) => {
  const q = quality(files, cliThresholds)
  const ci = clear(scoredItems)
  const bci = clear(baseRun.scored)
  const fCi = isBase ? "" : ` [${pairedInterval(baseFiles, files, auroc).map(signed).join(", ")}]`
  const prCi = isBase ? "" : ` [${pairedInterval(bci, ci, auprc).map(signed).join(", ")}]`
  console.log(
    `| ${name} | ${q.auroc.toFixed(3)}${fCi} | ${pct(tprAtFpr(files, 0.05))} | ${q.brier.toFixed(3)} | ` +
    `${pct(q.caught)} | ${pct(q.falseAlarms)} | ${auroc(ci).toFixed(3)} | ${auprc(ci).toFixed(3)}${prCi} | ` +
    `${pct(violationPrecision(ci, cliThresholds))} | ${reqs} | ${costPerThousand(tokens, fileCount)} |`
  )
}

console.log(`\nH30 In-batch contrastive calibration anchors (6 policies, ${fileCases.length} dev real cases, ${items.length} items, ${model.name}):\n`)
console.log("| Variant | File AUROC | TPR@5% | Brier | Caught | FA | Item AUROC | Item PR-AUC | Item Prec(V) | Reqs | $/1k files |")
console.log("|---|---|---|---|---|---|---|---|---|---|---|")
reportRow("Baseline", baseFiles, baseRun.scored, baseRun.requests, baseTokens, true)
reportRow("In-batch anchors (raw)", rawFiles, rawItems, ancRequests, ancTokens, false)
reportRow("In-batch anchors + batch logit cal", batchCalFiles, batchCalItems, ancRequests, ancTokens, false)
reportRow("In-batch anchors + policy logit cal", policyCalFiles, policyCalItems, ancRequests, ancTokens, false)
reportRow("Baseline + policy anchor logit cal", probeCalFiles, probeCalItems, baseRun.requests + 6, baseTokens, false)

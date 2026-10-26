// Discovers candidate review norms from PR review comments (RESEARCH.md, H23): the mechanical half of a
// rule-mining tool. Reads the review comments `mine.ts` cached, keeps human top-level comments on source
// files, asks Clef which ones invoke a general norm rather than a one-off fix, embeds every comment
// (Workers AI, bge-m3), and clusters the kept ones into themes ranked by distinct reviewers. Naming themes
// and scoring them against each repo's documented norms happens in the research kernel.
//   bun evals/discover.ts [--similarity 0.6] <owner/repo> ...
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { type Question, planRequests } from "../src/clef.ts"
import { makeClient } from "./client.ts"

const reviewRaw = join(import.meta.dir, ".cache/research/review/raw")
const out = join(import.meta.dir, ".cache/research/discover")
const embeddingModel = "@cf/baai/bge-m3"
const embeddingBatch = 32
// A comment counts as invoking a norm at Clef's default review floor.
const keepAt = 0.5

const args = Bun.argv.slice(2)
const similarityIndex = args.indexOf("--similarity")
const similarity = similarityIndex === -1 ? 0.6 : Number(args[similarityIndex + 1])
const repos = args.filter((arg, index) => arg !== "--similarity" && args[index - 1] !== "--similarity")
if (repos.length === 0 || !(similarity > 0 && similarity < 1)) {
  console.error("usage: bun evals/discover.ts [--similarity 0.6] <owner/repo> ...")
  process.exit(1)
}

// The same file filters as mine.ts.
const sourceFile = /\.(tsx?|jsx?|py|go)$/
const generatedFile = /(^|\/)(vendor|node_modules)\/|_generated|\.pb\.go$|(^|\/)zz_generated/

interface RawComment {
  readonly id: number
  readonly html_url: string
  readonly user: { readonly login: string; readonly type: string } | null
  readonly created_at: string
  readonly path: string
  readonly body: string
  readonly diff_hunk: string
  readonly in_reply_to_id?: number
}

export interface ReviewComment {
  readonly id: number
  readonly url: string
  readonly author: string
  readonly createdAt: string
  readonly path: string
  /** The comment without fenced code blocks (suggestions, quoted code). */
  readonly prose: string
  /** The last lines of the diff hunk the comment is attached to. */
  readonly code: string
  /** Clef's probability that the comment invokes a general norm. */
  readonly norm: number
}

const prose = (body: string) => body.replace(/```[\s\S]*?(```|$)/g, "").trim()
const isBot = (user: RawComment["user"]) => user === null || user.type === "Bot" || user.login.endsWith("[bot]")
const lastLines = (text: string, count: number) => text.split("\n").slice(-count).join("\n")

const loadComments = async (repo: string) => {
  const directory = join(reviewRaw, repo.replace("/", "__"))
  const glob = new Bun.Glob("comments-*.json")
  const seen = new Set<number>()
  const comments: Array<RawComment> = []
  for await (const file of glob.scan(directory)) {
    for (const comment of (await Bun.file(join(directory, file)).json()) as Array<RawComment>) {
      if (seen.has(comment.id)) continue
      seen.add(comment.id)
      comments.push(comment)
    }
  }
  if (comments.length === 0) throw new Error(`${repo}: no cached review comments; run bun evals/mine.ts ${repo} first`)
  return comments
    .filter((comment) =>
      comment.in_reply_to_id === undefined && !isBot(comment.user) && sourceFile.test(comment.path) &&
      !generatedFile.test(comment.path) && prose(comment.body) !== ""
    )
    .toSorted((a, b) => a.id - b.id)
}

// --- Keep: does the comment invoke a general norm? (Clef) ----------------------------------------------

const keepState = "Each question shows one code review comment left on a pull request, with the end of the code " +
  "it points at. Decide whether the reviewer asks for a change because of a general rule about how code in this " +
  "project should be written: a norm that would apply to other code too, not just this line."
const keepCriteria = {
  true: "The comment asks for a change that follows from a general coding norm (naming, design, structure, error " +
    "handling, testing, comments, API conventions, and the like) that would also apply elsewhere in the project.",
  false: "The comment is about this code only: a bug in this logic, a question, a typo, approval, or a one-off " +
    "request with no general norm behind it."
}
const keepQuestion = (comment: RawComment): Question => ({
  instructions: `File: ${comment.path}\nCode:\n${lastLines(comment.diff_hunk, 20)}\n\nComment:\n${prose(comment.body).slice(0, 2000)}`,
  criteria: keepCriteria
})

const ask = makeClient(8)
const judgeNorms = async (comments: ReadonlyArray<RawComment>) => {
  const { requests, oversized } = planRequests(keepState, comments.map(keepQuestion))
  if (oversized.length > 0) throw new Error(`${oversized.length} comments too large for one request`)
  const scores: Array<number> = []
  let inputTokens = 0
  await Promise.all(requests.map(async (request) => {
    const reply = await ask(request.body)
    if (!reply.cached) inputTokens += reply.inputTokens
    for (const { id, value } of request.questions) {
      const noul = reply.answers[id]?.noul
      if (typeof noul !== "number") throw new Error(`no answer for ${id}`)
      scores[value] = noul
    }
  }))
  return { scores, inputTokens }
}

// --- Embed (Workers AI), cached per text --------------------------------------------------------------

const embeddingCacheFile = join(out, "embeddings.json")
const embeddingCache: Record<string, Array<number>> = await Bun.file(embeddingCacheFile).exists()
  ? await Bun.file(embeddingCacheFile).json()
  : {}
const textKey = (text: string) => new Bun.CryptoHasher("sha256").update(embeddingModel).update("\0").update(text).digest("hex")

export const embed = async (texts: ReadonlyArray<string>): Promise<Array<Array<number>>> => {
  const missing = [...new Set(texts.filter((text) => embeddingCache[textKey(text)] === undefined))]
  for (let start = 0; start < missing.length; start += embeddingBatch) {
    const batch = missing.slice(start, start + embeddingBatch)
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${Bun.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${embeddingModel}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${Bun.env.CLOUDFLARE_AUTH_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ text: batch })
      }
    )
    if (!response.ok) throw new Error(`embeddings ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const { result } = (await response.json()) as { result: { data: Array<Array<number>> } }
    batch.forEach((text, index) => (embeddingCache[textKey(text)] = result.data[index]!))
    await Bun.write(embeddingCacheFile, JSON.stringify(embeddingCache))
  }
  return texts.map((text) => embeddingCache[textKey(text)]!)
}

const cosine = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return dot / Math.sqrt(na * nb)
}

// --- Cluster: average linkage until no pair of clusters is at least `similarity` alike -----------------

const cluster = (vectors: ReadonlyArray<ReadonlyArray<number>>, threshold: number): Array<Array<number>> => {
  const pair = vectors.map((a) => vectors.map((b) => cosine(a, b)))
  let clusters = vectors.map((_, index) => [index])
  for (;;) {
    let best = { score: -1, i: -1, j: -1 }
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        let sum = 0
        for (const a of clusters[i]!) for (const b of clusters[j]!) sum += pair[a]![b]!
        const score = sum / (clusters[i]!.length * clusters[j]!.length)
        if (score > best.score) best = { score, i, j }
      }
    }
    if (best.score < threshold) return clusters
    clusters = [...clusters.filter((_, index) => index !== best.i && index !== best.j), [...clusters[best.i]!, ...clusters[best.j]!]]
  }
}

// --- Run --------------------------------------------------------------------------------------------

mkdirSync(join(out, "themes"), { recursive: true })
const rows: Array<Array<string | number>> = []
for (const repo of repos) {
  const raw = await loadComments(repo)
  const { scores, inputTokens } = await judgeNorms(raw)
  const comments: Array<ReviewComment> = raw.map((comment, index) => ({
    id: comment.id,
    url: comment.html_url,
    author: comment.user!.login,
    createdAt: comment.created_at,
    path: comment.path,
    prose: prose(comment.body),
    code: lastLines(comment.diff_hunk, 20),
    norm: scores[index]!
  }))
  const vectors = await embed(comments.map((comment) => comment.prose.slice(0, 2000)))
  const kept = comments.flatMap((comment, index) => (comment.norm >= keepAt ? [index] : []))
  const themes = cluster(kept.map((index) => vectors[index]!), similarity)
    .map((members) => members.map((member) => kept[member]!))
    .filter((members) => members.length >= 2)
    .map((members) => ({
      comments: members.map((index) => comments[index]!.id),
      reviewers: new Set(members.map((index) => comments[index]!.author)).size
    }))
    .toSorted((a, b) => b.reviewers - a.reviewers || b.comments.length - a.comments.length)
  const dates = comments.map((comment) => comment.createdAt).toSorted()
  await Bun.write(
    join(out, "themes", `${repo.replace("/", "__")}.json`),
    JSON.stringify({ repo, similarity, keepAt, embeddingModel, from: dates[0], to: dates.at(-1), comments, themes }, null, 1)
  )
  const clustered = themes.reduce((sum, theme) => sum + theme.comments.length, 0)
  rows.push([repo, comments.length, kept.length, themes.length, clustered, `${dates[0]!.slice(0, 10)}..${dates.at(-1)!.slice(0, 10)}`, inputTokens])
}

const header = ["repo", "comments", "norm", "themes", "in themes", "window", "new Clef tokens"]
console.log(header.join("\t"))
for (const row of rows) console.log(row.join("\t"))

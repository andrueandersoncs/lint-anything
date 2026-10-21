// Mines candidate violations for H3: recent PR review comments in permissively licensed repos whose prose
// matches a semantic policy's keywords, on source files, with the PR's merge/head commits attached so the
// file can later be fetched before and after the fix. Raw API pages are cached, so reruns don't refetch.
//   bun evals/mine.ts [--pages 10] <owner/repo> ...
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"

const out = join(import.meta.dir, ".cache/research/review")
const candidatesPath = join(out, "candidates.jsonl")
const summaryPath = join(out, "summary.json")
const perPage = 100
// Requests left untouched at the end, so other work using the same token isn't starved.
const rateReserve = 100

const pagesIndex = Bun.argv.indexOf("--pages")
const pages = pagesIndex === -1 ? 10 : Number(Bun.argv[pagesIndex + 1])
const repos = Bun.argv.slice(2).filter((arg, i, args) => arg !== "--pages" && args[i - 1] !== "--pages")
if (repos.length === 0 || !Number.isInteger(pages) || pages < 1) {
  console.error("usage: bun evals/mine.ts [--pages N] <owner/repo> ...")
  process.exit(1)
}

const licenses = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD"])
const sourceFile = /\.(tsx?|jsx?|py|go)$/
const generatedFile = /(^|\/)(vendor|node_modules)\/|_generated|\.pb\.go$|(^|\/)zz_generated/

// Keyword pre-filter, aiming for recall: a later labeling step decides whether the concern is real.
const decisionsFromEffects = String.raw`business logic|side[- ]?effects?|pure (function|logic)|\bimpure\b|handlers? (should|shouldn't|should not)|\bmove (this|the logic|it|that)\b`
const responsibility = String.raw`too (much|many)|does (too much|two things|a lot)|\bsplit|\bextract|\bhelper|separate (function|file|module|method|class|package)|belongs (in|to)`
const naming = String.raw`\brenam|\bnaming\b|better name|misleading|confusing( name)?|\bname (is|isn't|doesn't|does not|should|could|suggests|implies)|call (it|this) `
const testing = String.raw`test name|rename (the |this )?test|implementation details?|testing internals|assert(ing|s)? on (the )?mocks?|brittle|over-?mock`
const keywords: Record<string, string> = {
  "architecture/separate-decisions-from-effects": String.raw`${decisionsFromEffects}|\bI/O\b|decoupl|testable without`,
  "architecture/thin-entry-points": String.raw`${decisionsFromEffects}|(handler|endpoint|command|controller|view|main|route)s? (is|are) doing|(fat|thin) (handler|controller|view|command)|logic (in|out of) (the )?(handler|controller|view|command|cli|main)`,
  "design/explicit-dependencies": String.raw`\bglobals?\b|singleton|\binject|dependency injection|pass (it|this|that|the \w+) in\b|package[- ]level (var|variable|state)|module[- ]level (var|variable|state)|hard-?coded (client|path|dependency|url)`,
  "design/no-flag-parameters": String.raw`bool(ean)? (param|arg|flag|option)|flag (param|arg)|two (separate )?(functions|methods)|split (this|it) into|\bboolean trap`,
  "design/preserve-error-context": String.raw`%w|wrap(ped|ping)? (the )?err|lose[s]? the (original )?(error|exception|stack|traceback)|from e\b|\bcause\b|swallow|error context|context (to|in) the error|raise \w+ from|stack ?trace`,
  "design/single-responsibility": responsibility,
  "encapsulation/minimal-public-surface": String.raw`unexport|\bexport(ed|s)? |\bprivate\b|public api|public surface|make (this|it) private|need to be (exported|public)|leading underscore`,
  "encapsulation/protect-internal-state": String.raw`copy (of )?(the )?(slice|map|array|list|dict)|defensive(ly)? cop|\bmutat|expos(e|es|ing) (the )?internal|internal state|\bclone\b|aliasing`,
  "maintainability/no-duplicated-knowledge": String.raw`duplicat|copy-?past|same (logic|code|thing|check) as|\bdry\b|\breuse|already (exists|defined|have)|single source of truth`,
  "naming/intent-revealing-names": String.raw`${naming}|(more )?descriptive( name)?|\bvague\b|unclear name`,
  "naming/names-match-behavior": String.raw`${naming}|name (no longer|doesn't match|does not match)|not what (the name|it) (says|implies)`,
  "organization/cohesive-modules": String.raw`${responsibility}|unrelated|doesn't belong|does not belong|(own|separate|different) (file|module|package)`,
  "readability/comments-explain-why": String.raw`comment (is|isn't|doesn't|does not|seems|says|should)|(outdated|stale|redundant|misleading|obsolete|wrong) comment|explain why|comment (explaining|on why)|update the (doc|comment|docstring)`,
  "readability/consistent-abstraction-level": String.raw`${responsibility}|abstraction|low[- ]level|high[- ]level|level of detail`,
  "readability/explain-magic-values": String.raw`magic (number|value|string|constant)|named const|(a |use a )?constant for|hard-?coded|\bliteral\b|where does (this|the) \S+ come from|why \d+`,
  "testing/descriptive-test-names": String.raw`${testing}|test (name|title|description) (is|should|could)|describe (what|the) (this )?test`,
  "testing/test-behavior-not-implementation": String.raw`${testing}|\bmocks?\b.{0,40}(instead|rather|real)|test (the )?behaviou?r|private method`,
}
const matchers = Object.entries(keywords).map(([policy, pattern]) => ({ policy, regex: new RegExp(pattern, "i") }))

type User = { login: string; type: string } | null
type Comment = {
  id: number
  html_url: string
  pull_request_url: string
  user: User
  created_at: string
  path: string
  body: string
  diff_hunk: string
  original_commit_id: string
  commit_id: string
  line: number | null
  original_line: number | null
  start_line: number | null
  original_start_line: number | null
  in_reply_to_id?: number
}
type Pull = { merged: boolean; mergeCommit: string | null; head: string; base: string }
type RepoSummary = {
  license: string | null
  skipped?: string
  pagesFetched: number
  rateLimited: boolean
  fetched: number
  fileFiltered: number
  keywordKept: number
  newCandidates: number
  policies: Record<string, number>
}

let remaining = (await $`gh api rate_limit --jq .resources.core.remaining`.json()) as number

// Cached `gh api` call, or undefined when the rate budget is spent and nothing is cached.
const cached = async <A>(file: string, path: string, jq?: string): Promise<A | undefined> => {
  const cache = Bun.file(file)
  if (await cache.exists()) return (await cache.json()) as A
  if (remaining <= rateReserve) return undefined
  remaining -= 1
  const value = (await (jq === undefined ? $`gh api ${path}` : $`gh api ${path} --jq ${jq}`).json()) as A
  await Bun.write(file, JSON.stringify(value))
  return value
}

const isBot = (user: User) => user !== null && (user.type === "Bot" || user.login.endsWith("[bot]"))
// Prose only: fenced blocks (suggestions, quoted code) would match keywords on identifiers.
const prose = (body: string) => body.replace(/```[\s\S]*?(```|$)/g, "").trim()

mkdirSync(out, { recursive: true })
const seen = new Set<number>()
if (existsSync(candidatesPath)) {
  for (const line of (await Bun.file(candidatesPath).text()).split("\n")) {
    if (line !== "") seen.add((JSON.parse(line) as { commentId: number }).commentId)
  }
}
const summary: Record<string, RepoSummary> = existsSync(summaryPath) ? await Bun.file(summaryPath).json() : {}

for (const repo of repos) {
  const raw = join(out, "raw", repo.replace("/", "__"))
  mkdirSync(raw, { recursive: true })
  const result: RepoSummary = {
    license: null,
    pagesFetched: 0,
    rateLimited: false,
    fetched: 0,
    fileFiltered: 0,
    keywordKept: 0,
    newCandidates: 0,
    policies: {},
  }
  summary[repo] = result
  // An object, because `gh --jq` prints bare strings unquoted.
  const repoInfo = await cached<{ license: string | null }>(join(raw, "repo.json"), `repos/${repo}`, "{license: .license.spdx_id}")
  const license = repoInfo?.license
  if (license === undefined) {
    result.rateLimited = true
    continue
  }
  result.license = license
  if (license === null || !licenses.has(license)) {
    result.skipped = `license ${license}`
    continue
  }

  const comments: Array<Comment> = []
  for (let page = 1; page <= pages; page++) {
    const path = `repos/${repo}/pulls/comments?sort=created&direction=desc&per_page=${perPage}&page=${page}`
    const batch = await cached<Array<Comment>>(join(raw, `comments-${page}.json`), path)
    if (batch === undefined) {
      result.rateLimited = true
      break
    }
    result.pagesFetched = page
    comments.push(...batch)
    if (batch.length < perPage) break
  }
  result.fetched = comments.length

  const onSource = comments.filter((c) => sourceFile.test(c.path) && !generatedFile.test(c.path))
  result.fileFiltered = onSource.length
  const kept = onSource.flatMap((comment) => {
    const text = prose(comment.body)
    if (isBot(comment.user) || text === "") return []
    const policies = matchers.filter(({ regex }) => regex.test(text)).map(({ policy }) => policy)
    return policies.length === 0 ? [] : [{ comment, policies }]
  })
  result.keywordKept = kept.length
  for (const { policies } of kept) for (const policy of policies) result.policies[policy] = (result.policies[policy] ?? 0) + 1

  const lines: Array<string> = []
  const pulls = new Map<number, Pull | undefined>()
  for (const { comment, policies } of kept) {
    if (seen.has(comment.id)) continue
    const pr = Number(comment.pull_request_url.split("/").pop())
    if (!pulls.has(pr)) {
      const jq = "{merged: .merged, mergeCommit: .merge_commit_sha, head: .head.sha, base: .base.sha}"
      pulls.set(pr, await cached<Pull>(join(raw, `pull-${pr}.json`), `repos/${repo}/pulls/${pr}`, jq))
    }
    const pull = pulls.get(pr)
    if (pull === undefined) {
      result.rateLimited = true
      break
    }
    seen.add(comment.id)
    lines.push(
      JSON.stringify({
        repo,
        license,
        pr,
        commentId: comment.id,
        url: comment.html_url,
        author: comment.user?.login ?? null,
        createdAt: comment.created_at,
        path: comment.path,
        body: comment.body,
        diffHunk: comment.diff_hunk,
        originalCommit: comment.original_commit_id,
        commit: comment.commit_id,
        line: comment.line,
        originalLine: comment.original_line,
        startLine: comment.start_line,
        originalStartLine: comment.original_start_line,
        inReplyTo: comment.in_reply_to_id ?? null,
        policies,
        pull,
      }),
    )
  }
  result.newCandidates = lines.length
  if (lines.length > 0) {
    const previous = existsSync(candidatesPath) ? await Bun.file(candidatesPath).text() : ""
    await Bun.write(candidatesPath, previous + lines.map((line) => `${line}\n`).join(""))
  }
}

await Bun.write(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)

const pad = (value: string | number, width: number) => String(value).padStart(width)
console.log(`${"repo".padEnd(32)} ${pad("license", 12)} ${pad("fetched", 8)} ${pad("files", 6)} ${pad("kept", 6)} ${pad("new", 5)}`)
for (const [repo, result] of Object.entries(summary)) {
  const note = result.skipped ?? (result.rateLimited ? `rate-limited after ${result.pagesFetched} pages` : "")
  console.log(
    `${repo.padEnd(32)} ${pad(result.license ?? "-", 12)} ${pad(result.fetched, 8)} ${pad(result.fileFiltered, 6)} ${pad(result.keywordKept, 6)} ${pad(result.newCandidates, 5)}  ${note}`,
  )
}
console.log("\nper policy (comments matching; a comment can match several)")
for (const policy of Object.keys(keywords)) {
  const counts = Object.values(summary).map((result) => result.policies[policy] ?? 0)
  console.log(`${policy.padEnd(48)} ${pad(counts.reduce((a, b) => a + b, 0), 6)}`)
}
console.log(`\n${remaining} API requests left`)

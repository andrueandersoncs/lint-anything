import { Effect } from "effect"
import { parsePolicy, type Policy } from "../src/policy.ts"

export const corpusDirectory = `${import.meta.dir}/corpus`

// Corpus selectors call helper steps as `bun "$EVAL_STEPS/<step>.ts"` (see evals/steps/), and the repo's dev
// tools (such as `ast-grep`) by name.
process.env.EVAL_STEPS = `${import.meta.dir}/steps`
process.env.PATH = `${import.meta.dir}/../node_modules/.bin:${process.env.PATH}`

/**
 * `ambiguous`: independent labelers could not agree under the policy text. Scored at file level, where the
 * ideal verdict is `review`; excluded from AUROC and from item labels.
 */
export type Label = "violates" | "complies" | "not-applicable" | "ambiguous"
/** `semantic` policies are the intended use; `control` policies are mechanical, kept for comparison. */
export type Category = "semantic" | "control"

/** A policy's category is the first segment of its name (`semantic/naming/…`, `control/…`). */
export const categoryOf = (policyName: string): Category => (policyName.startsWith("control/") ? "control" : "semantic")
export type Split = "dev" | "test"
/** `synthetic`: written for the corpus. `real`: verbatim from an open-source project. `planted`: a real file with one violation added. */
export type Origin = "synthetic" | "real" | "planted"

/** Where a real (or planted) file came from: `path` in GitHub repo `repo` (`owner/name`) at `commit`. */
export interface Upstream {
  readonly repo: string
  readonly commit: string
  readonly path: string
  /** SPDX id; its text is stored at `corpus/licenses/<owner>__<name>.txt`. */
  readonly license: string
}

/**
 * How a file entered the corpus. `curated`: picked by hand. `sampled`: drawn at random by `evals/sample.ts`.
 * `mined`: a PR review comment flagged it (`evals/mine.ts`). `hand-planted` / `llm-planted`: a real file
 * with one violation added by hand or by a model. `written`: synthetic.
 */
export type Source = "curated" | "sampled" | "mined" | "hand-planted" | "llm-planted" | "written"

/** What later tests need to know about a file's sampling (H5), origin (H7) and date (H8). */
export interface Provenance {
  readonly source: Source
  /** Sampled files: `<language>/<test|source>/<size bin>`, the stratum it was drawn from. */
  readonly stratum?: string
  /** Real and planted files: ISO date of the last upstream commit that touched the file at `upstream.commit`. */
  readonly committed?: string
  /** Mined files: URL of the review comment that flagged the file. */
  readonly comment?: string
  /** LLM-planted files: the policy whose violation was planted. */
  readonly policy?: string
}

/** A gold judgment of one file against one policy. `lines` are 1-based inclusive ranges of the violation. */
export interface Gold {
  readonly label: Label
  readonly lines?: ReadonlyArray<readonly [number, number]>
  readonly note: string
}

/** One corpus file as stored in `corpus/<slice>.jsonl`; its text lives at `corpus/files/<id>/<path>`. */
export interface FileRecord {
  readonly id: string
  readonly path: string
  readonly split?: Split
  readonly origin: Origin
  readonly upstream?: Upstream
  readonly provenance: Provenance
  /** The other half of a contrast pair: the same file with one policy's violations fixed or planted. */
  readonly pair?: string
  readonly labels: Readonly<Record<string, Gold>>
  /**
   * Gold for the same semantic policies worded differently: `wordings[set][policy]` is labeled against
   * `corpus/wordings/<set>/<policy>.md`. A file carries a set for every policy of that set it has a label for.
   */
  readonly wordings?: Readonly<Record<string, Readonly<Record<string, Gold>>>>
}

export interface CorpusFile extends FileRecord {
  readonly slice: string
  readonly source: string
}

/** One scored unit: a file judged against one policy it has a label for (the labels say which policies apply). */
export interface Case {
  readonly id: string
  readonly file: CorpusFile
  readonly policy: Policy
  readonly gold: Gold
}

export interface Corpus {
  readonly policies: ReadonlyArray<Policy>
  readonly files: ReadonlyArray<CorpusFile>
  readonly cases: ReadonlyArray<Case>
}

const labels = new Set<string>(["violates", "complies", "not-applicable", "ambiguous"])
const origins = new Set<string>(["synthetic", "real", "planted"])
const sourcesByOrigin: Readonly<Record<Origin, ReadonlyArray<Source>>> = {
  synthetic: ["written"],
  real: ["curated", "sampled", "mined"],
  planted: ["hand-planted", "llm-planted"]
}
// Licenses that allow redistributing the files here with attribution.
const permissiveLicenses = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD"])

export const licensePath = (repo: string) => `${corpusDirectory}/licenses/${repo.replace("/", "__")}.txt`

/**
 * Checks that every real file is byte-identical to its upstream at the pinned commit (needs network).
 * Fetches a few files at a time and retries dropped connections. Returns one problem per mismatch.
 */
export const verifyUpstream = async (files: ReadonlyArray<CorpusFile>): Promise<Array<string>> => {
  const fetchText = async (url: string): Promise<string | number> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(url)
        return response.ok ? await response.text() : response.status
      } catch (error) {
        if (attempt === 4) throw error
        await Bun.sleep(500 * attempt)
      }
    }
  }
  const real = files.filter((file) => file.origin === "real" && file.upstream !== undefined)
  const problems: Array<string> = []
  for (let start = 0; start < real.length; start += 8) {
    await Promise.all(real.slice(start, start + 8).map(async (file) => {
      const { repo, commit, path } = file.upstream!
      const upstream = await fetchText(`https://raw.githubusercontent.com/${repo}/${commit}/${path}`)
      if (typeof upstream === "number") problems.push(`${file.id}: upstream fetch ${upstream}`)
      else if (upstream !== file.source) problems.push(`${file.id}: differs from ${repo}@${commit}:${path}`)
    }))
  }
  return problems
}

// The eval corpus's convention: a policy body is framing for Clef, then a line that is exactly `Rule:`, then
// the rule text, which is what gold labels judge against.
const ruleLine = /^Rule:\r?\n/m

/** A policy body split at its `Rule:` line: the framing (through that line) and the rule text after it. */
const splitRule = (policy: Policy) => {
  const match = ruleLine.exec(policy.body)
  if (match === null) throw new Error(`${policy.name}: the body needs a line that is exactly "Rule:" before the rule text`)
  const end = match.index + match[0].length
  return { framing: policy.body.slice(0, end), rule: policy.body.slice(end) }
}

/** The rule text of an eval policy: everything after the first line that is exactly `Rule:`. */
export const ruleText = (policy: Policy) => splitRule(policy).rule

/** The policy with its rule text replaced, framing, selector, and criteria kept. */
export const withRuleText = (policy: Policy, rule: string): Policy => ({ ...policy, body: `${splitRule(policy).framing}${rule}` })

// The item framing and criteria the corpus policies use; ad hoc eval policies use them too, so their
// requests ask what the corpus policies ask.
const itemFraming = "Each question shows one item with its location and any context. Decide whether that item contains at " +
  "least one violation of the rule below.\nReturn a calibrated probability that the answer is yes."
const itemCriteria = {
  true: "The item contains at least one complete violation of the rule.",
  false: "The item follows the rule, or the rule governs nothing in it."
}

/**
 * An eval policy built in code, parsed as the CLI parses policies: the corpus framing, a `Rule:` line, and
 * `rule`, with the corpus item criteria. `select` should end in `bun "$EVAL_STEPS/present.ts"`, which writes
 * each item's location and context into its text as the corpus selectors do.
 */
export const adHocPolicy = (name: string, select: string, rule: string, limit?: { readonly max: number; readonly per: "file" | "run" }) =>
  Effect.runSync(parsePolicy(name, `---\n${Bun.YAML.stringify({ select, criteria: itemCriteria, ...(limit === undefined ? {} : { limit }) }, null, 2)}\n---\n` +
    `${itemFraming}\n\nRule:\n${rule}\n`))

const parseDirectory = async (directory: string): Promise<Array<Policy>> => {
  const names = (await Array.fromAsync(new Bun.Glob("**/*.md").scan(directory))).sort()
  return Promise.all(names.map(async (name) => {
    const policy = Effect.runSync(parsePolicy(name.slice(0, -".md".length), await Bun.file(`${directory}/${name}`).text()))
    splitRule(policy)
    return policy
  }))
}

const frontmatterPattern = /^---\r?\n.*?\r?\n---(?:\r?\n|$)/s

/**
 * Rule-wording sets: one directory per set under `corpus/wordings`, each file only rule text for the corpus
 * policy of the same name. A reworded policy is the corpus policy with its rule text replaced, so the two
 * differ only in rule text.
 */
export const loadWordings = async (defaults?: ReadonlyArray<Policy>): Promise<Map<string, Array<Policy>>> => {
  const policies = defaults ?? await parseDirectory(`${corpusDirectory}/policies`)
  const directory = `${corpusDirectory}/wordings`
  const files = (await Array.fromAsync(new Bun.Glob("*/**/*.md").scan(directory))).sort()
  const wordings = new Map<string, Array<Policy>>()
  for (const file of files) {
    const [set, ...rest] = file.split("/")
    const name = rest.join("/").slice(0, -".md".length)
    const original = policies.find((policy) => policy.name === name)
    if (original === undefined) throw new Error(`wording ${set}: ${name} is not a corpus policy`)
    const rule = await Bun.file(`${directory}/${file}`).text()
    if (frontmatterPattern.test(rule)) throw new Error(`wording ${set}: ${name} must hold only the rule text`)
    wordings.set(set!, [...(wordings.get(set!) ?? []), withRuleText(original, rule)])
  }
  return wordings
}

/**
 * Policies in `corpus/policies`, parsed exactly as the CLI parses them. With `wording`, each policy that
 * set rewords is replaced by its `corpus/wordings/<wording>` text (same name and selector).
 */
export const loadPolicies = async (wording?: string): Promise<Array<Policy>> => {
  const policies = await parseDirectory(`${corpusDirectory}/policies`)
  if (wording === undefined) return policies
  const reworded = (await loadWordings(policies)).get(wording)
  if (reworded === undefined) throw new Error(`no wording set ${wording} in ${corpusDirectory}/wordings`)
  const byName = new Map(reworded.map((policy) => [policy.name, policy]))
  return policies.map((policy) => byName.get(policy.name) ?? policy)
}

const checkGold = (where: string, gold: Gold, lineCount: number, problems: Array<string>) => {
  if (!labels.has(gold.label)) problems.push(`${where}: unknown label ${gold.label}`)
  if (typeof gold.note !== "string" || gold.note.trim() === "") problems.push(`${where}: missing note`)
  if (gold.label === "violates" && (gold.lines === undefined || gold.lines.length === 0)) {
    problems.push(`${where}: violates needs lines`)
  }
  for (const [start, end] of gold.lines ?? []) {
    if (!(1 <= start && start <= end && end <= lineCount)) problems.push(`${where}: lines ${start}-${end} outside 1-${lineCount}`)
  }
}

/**
 * Loads every slice and checks it: each file exists, its labels name corpus policies (and each wording set
 * it carries labels exactly the reworded policies it has labels for), pairs are reciprocal with the
 * same path, and provenance fits the origin. Throws one error listing every problem. With `wording`, cases
 * are judged against that set's text and gold, and only files labeled for that set are loaded.
 */
export const loadCorpus = async (
  options: { readonly requireSplits?: boolean; readonly wording?: string } = {}
): Promise<Corpus> => {
  const defaults = await loadPolicies()
  const policies = await loadPolicies(options.wording)
  const byName = new Map(policies.map((policy) => [policy.name, policy]))
  const wordings = await loadWordings(defaults)
  const problems: Array<string> = []
  const files: Array<CorpusFile> = []
  for (const name of (await Array.fromAsync(new Bun.Glob("*.jsonl").scan(corpusDirectory))).sort()) {
    const slice = name.slice(0, -".jsonl".length)
    const lines = (await Bun.file(`${corpusDirectory}/${name}`).text()).split("\n")
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue
      const where = `${name}:${index + 1}`
      let record: FileRecord
      try {
        record = JSON.parse(line)
      } catch (error) {
        problems.push(`${where}: invalid JSON (${error})`)
        continue
      }
      const location = `${corpusDirectory}/files/${record.id}/${record.path}`
      const file = Bun.file(location)
      if (!(await file.exists())) {
        problems.push(`${where}: ${record.id}: missing ${location}`)
        continue
      }
      // Selectors find files themselves, run from this directory, so it must hold only this file.
      const others = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: `${corpusDirectory}/files/${record.id}`, dot: true })))
        .filter((path) => path !== record.path)
      if (others.length > 0) problems.push(`${where}: ${record.id}: files/${record.id} holds more than its file: ${others.join(", ")}`)
      files.push({ ...record, slice, source: await file.text() })
    }
  }
  const byId = new Map<string, CorpusFile>()
  for (const file of files) {
    if (byId.has(file.id)) problems.push(`${file.id}: duplicate id`)
    byId.set(file.id, file)
  }
  const cases: Array<Case> = []
  const loaded: Array<CorpusFile> = []
  for (const file of files) {
    // A file's labels name the policies that apply to it; each must be a corpus policy.
    const expected = Object.keys(file.labels)
    for (const name of expected.filter((name) => !defaults.some((policy) => policy.name === name))) {
      problems.push(`${file.id}: label for ${name}, which is not a corpus policy`)
    }
    if (options.requireSplits && file.split !== "dev" && file.split !== "test") {
      problems.push(`${file.id}: split must be dev or test`)
    }
    if (file.pair !== undefined) {
      const partner = byId.get(file.pair)
      if (partner === undefined) problems.push(`${file.id}: pair ${file.pair} does not exist`)
      else if (partner.pair !== file.id) problems.push(`${file.id}: pair ${file.pair} does not point back`)
      else if (partner.path !== file.path) problems.push(`${file.id}: pair ${file.pair} has a different path`)
      else if (partner.split !== file.split) problems.push(`${file.id}: pair ${file.pair} is in a different split`)
    }
    if (!origins.has(file.origin)) problems.push(`${file.id}: origin must be synthetic, real, or planted`)
    const provenance = file.provenance
    if (provenance === undefined) {
      problems.push(`${file.id}: missing provenance`)
    } else {
      if (!sourcesByOrigin[file.origin]?.includes(provenance.source)) {
        problems.push(`${file.id}: provenance source ${provenance.source} does not fit origin ${file.origin}`)
      }
      if (file.origin !== "synthetic" && !(typeof provenance.committed === "string" && !Number.isNaN(Date.parse(provenance.committed)))) {
        problems.push(`${file.id}: provenance needs the committed date`)
      }
      if (provenance.source === "sampled" && provenance.stratum === undefined) problems.push(`${file.id}: sampled files need a stratum`)
      if (provenance.source === "mined" && provenance.comment === undefined) problems.push(`${file.id}: mined files need the comment URL`)
      if (provenance.source === "llm-planted" && file.labels[provenance.policy ?? ""]?.label !== "violates") {
        problems.push(`${file.id}: llm-planted files name a planted policy they violate`)
      }
    }
    if (file.origin === "synthetic") {
      if (file.upstream !== undefined) problems.push(`${file.id}: synthetic files have no upstream`)
    } else {
      const upstream = file.upstream
      if (upstream === undefined) {
        problems.push(`${file.id}: ${file.origin} files need upstream`)
      } else {
        if (!/^[\w.-]+\/[\w.-]+$/.test(upstream.repo)) problems.push(`${file.id}: upstream repo must be owner/name`)
        if (!/^[0-9a-f]{40}$/.test(upstream.commit)) problems.push(`${file.id}: upstream commit must be a full SHA`)
        if (upstream.path !== file.path) problems.push(`${file.id}: path must equal upstream.path`)
        if (!permissiveLicenses.has(upstream.license)) {
          problems.push(`${file.id}: license ${upstream.license} is not one of ${[...permissiveLicenses].join(", ")}`)
        }
        if (!(await Bun.file(licensePath(upstream.repo)).exists())) {
          problems.push(`${file.id}: missing license text ${licensePath(upstream.repo)}`)
        }
      }
      const partner = file.pair === undefined ? undefined : byId.get(file.pair)
      if (file.origin === "planted") {
        if (partner?.origin !== "real") problems.push(`${file.id}: planted files must pair with a real file`)
        else if (JSON.stringify(partner.upstream) !== JSON.stringify(upstream)) {
          problems.push(`${file.id}: upstream differs from its real pair ${partner.id}`)
        } else if (partner.source === file.source) problems.push(`${file.id}: identical to its real pair`)
      }
    }
    const lineCount = file.source.split("\n").length
    for (const name of expected) {
      const gold = file.labels[name]
      if (gold !== undefined) checkGold(`${file.id} ${name}`, gold, lineCount, problems)
    }
    for (const [set, gold] of Object.entries(file.wordings ?? {})) {
      const reworded = wordings.get(set)
      if (reworded === undefined) {
        problems.push(`${file.id}: labels for unknown wording set ${set}`)
        continue
      }
      // A set labels every policy it rewords that applies to the file.
      const wanted = reworded.filter((policy) => expected.includes(policy.name)).map((policy) => policy.name)
      for (const name of wanted.filter((name) => gold[name] === undefined)) problems.push(`${file.id}: no ${set} label for ${name}`)
      for (const name of Object.keys(gold).filter((name) => !wanted.includes(name))) {
        problems.push(`${file.id}: ${set} label for ${name}, which that set does not reword or which does not apply to the file`)
      }
      for (const [name, value] of Object.entries(gold)) checkGold(`${file.id} ${set} ${name}`, value, lineCount, problems)
    }
    if (options.wording !== undefined && file.wordings?.[options.wording] === undefined) continue
    loaded.push(file)
    for (const name of expected) {
      const gold = file.wordings?.[options.wording ?? ""]?.[name] ?? file.labels[name]
      const policy = byName.get(name)
      if (gold === undefined || policy === undefined) continue
      cases.push({ id: `${file.id}:${name}`, file, policy, gold })
    }
  }
  if (problems.length > 0) {
    throw new Error(`corpus has ${problems.length} problem(s):\n${problems.join("\n")}`)
  }
  return { policies, files: loaded, cases }
}

import { Effect } from "effect"
import { matches, parsePolicy, type Policy } from "../src/policy.ts"

export const corpusDirectory = `${import.meta.dir}/corpus`

/** `ambiguous`: independent labelers could not agree under the policy text; excluded from scoring. */
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
  /** The other half of a contrast pair: the same file with one policy's violations fixed or planted. */
  readonly pair?: string
  readonly labels: Readonly<Record<string, Gold>>
}

export interface CorpusFile extends FileRecord {
  readonly slice: string
  readonly source: string
}

/** One scored unit: a file judged against one policy whose globs match its path. */
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

/** Policies in `corpus/policies`, parsed exactly as the CLI parses them. */
export const loadPolicies = async (): Promise<Array<Policy>> => {
  const directory = `${corpusDirectory}/policies`
  const names = (await Array.fromAsync(new Bun.Glob("**/*.md").scan(directory))).sort()
  return Promise.all(names.map(async (name) =>
    Effect.runSync(parsePolicy(name.slice(0, -".md".length), await Bun.file(`${directory}/${name}`).text()))
  ))
}

/**
 * Loads every slice and checks it: each file exists, carries exactly one label per policy whose globs
 * match its path, and pairs are reciprocal with the same path. Throws one error listing every problem.
 */
export const loadCorpus = async (options: { readonly requireSplits?: boolean } = {}): Promise<Corpus> => {
  const policies = await loadPolicies()
  const byName = new Map(policies.map((policy) => [policy.name, policy]))
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
      files.push({ ...record, slice, source: await file.text() })
    }
  }
  const byId = new Map<string, CorpusFile>()
  for (const file of files) {
    if (byId.has(file.id)) problems.push(`${file.id}: duplicate id`)
    byId.set(file.id, file)
  }
  const cases: Array<Case> = []
  for (const file of files) {
    const expected = policies.filter((policy) => matches(policy, file.path)).map((policy) => policy.name)
    const labelled = Object.keys(file.labels)
    for (const name of expected.filter((name) => !labelled.includes(name))) {
      problems.push(`${file.id}: no label for matching policy ${name}`)
    }
    for (const name of labelled.filter((name) => !expected.includes(name))) {
      problems.push(`${file.id}: label for ${name}, whose globs do not match ${file.path}`)
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
      const policy = byName.get(name)
      if (gold === undefined || policy === undefined) continue
      if (!labels.has(gold.label)) problems.push(`${file.id} ${name}: unknown label ${gold.label}`)
      if (typeof gold.note !== "string" || gold.note.trim() === "") problems.push(`${file.id} ${name}: missing note`)
      if (gold.label === "violates" && (gold.lines === undefined || gold.lines.length === 0)) {
        problems.push(`${file.id} ${name}: violates needs lines`)
      }
      for (const [start, end] of gold.lines ?? []) {
        if (!(1 <= start && start <= end && end <= lineCount)) {
          problems.push(`${file.id} ${name}: lines ${start}-${end} outside 1-${lineCount}`)
        }
      }
      cases.push({ id: `${file.id}:${name}`, file, policy, gold })
    }
  }
  if (problems.length > 0) {
    throw new Error(`corpus has ${problems.length} problem(s):\n${problems.join("\n")}`)
  }
  return { policies, files, cases }
}

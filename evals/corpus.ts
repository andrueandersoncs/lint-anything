import { Effect } from "effect"
import { matches, parsePolicy, type Policy } from "../src/policy.ts"

export const corpusDirectory = `${import.meta.dir}/corpus`

export type Label = "violates" | "complies" | "not-applicable"
export type Split = "dev" | "test"

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
  /** The other half of a contrast pair: the same file with one policy's violations fixed. */
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

const labels = new Set<string>(["violates", "complies", "not-applicable"])

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

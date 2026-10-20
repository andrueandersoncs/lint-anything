import {
  excerptBytes,
  excerpts,
  maxRequestBytes,
  type Model,
  planRequests as planProductionRequests
} from "../src/clef.ts"
import type { Policy } from "../src/policy.ts"
import type { SourceFile } from "../src/source.ts"

/** How a run turns files and policies into Clef requests. `production` is what the CLI sends. */
export interface Strategy {
  readonly model: Model
  /** Most questions per request: 1 sends one policy per request; more packs a file's policies together. */
  readonly batch: number
  /** Where the guidance goes: repeated in every question, or once in the state. */
  readonly guidance: "question" | "state"
  /**
   * The guidance itself: `short` asks whether the file contains a violation; `reviewer` asks whether a
   * careful reviewer holding the rule would flag something; `calibrated` is `short` plus an instruction
   * to answer near 0.5 when the rule genuinely supports both readings.
   */
  readonly wording: "short" | "reviewer" | "calibrated"
  /** The file as `{ path, file }` JSON or as labelled plain text. */
  readonly state: "object" | "text"
  /** Question ids: `p0…` by position, or the policy name. */
  readonly ids: "positional" | "slug"
  /**
   * A bare `noul`; a `noul` with yes/no criteria; a violates/complies/not-applicable `choice`; a
   * violates/borderline/complies `verdict` choice; or a three-level `scale` score (complies, borderline,
   * violates). Three-way answers score P(violates) + ½·P(borderline).
   */
  readonly question: "noul" | "criteria" | "choice" | "verdict" | "scale"
  /** 0 judges the whole file; N > 0 judges excerpts of at most N bytes and keeps each policy's highest score. */
  readonly chunk: number
  /**
   * `ask` adds a second yes/no question per policy — could careful reviewers reasonably disagree? — and
   * scores (1 − p_contested)·p_violates + ½·p_contested, pulling contested cases toward the middle.
   */
  readonly contest: "none" | "ask"
  /**
   * Stress test: also ask every corpus policy whose globs don't match the file, so each request carries
   * more questions. Only the matching (gold) questions are scored; the extra ones still cost tokens.
   */
  readonly pad: "none" | "all"
}

export const production: Strategy = {
  model: "clef",
  batch: 64,
  guidance: "state",
  wording: "short",
  state: "text",
  ids: "slug",
  question: "criteria",
  chunk: excerptBytes,
  contest: "none",
  pad: "none"
}

const options: { readonly [K in keyof Strategy]: ReadonlyArray<string> } = {
  model: ["clef", "clef-flash"],
  batch: [],
  guidance: ["question", "state"],
  wording: ["short", "reviewer", "calibrated"],
  state: ["object", "text"],
  ids: ["positional", "slug"],
  question: ["noul", "criteria", "choice", "verdict", "scale"],
  chunk: [],
  contest: ["none", "ask"],
  pad: ["none", "all"]
}

/** Parses `production` and/or `key=value` overrides of it, e.g. `production,model=clef-flash,batch=1`. */
export const parseStrategy = (spec: string): Strategy => {
  const strategy: Record<string, string | number> = { ...production }
  for (const part of spec.split(",").filter((part) => part !== "" && part !== "production")) {
    const [key, value] = part.split("=")
    if (key === undefined || value === undefined || !(key in options)) throw new Error(`bad strategy part: ${part}`)
    if (key === "batch") {
      const batch = Number(value)
      if (!Number.isInteger(batch) || batch < 1 || batch > maxQuestions) throw new Error(`batch must be 1-${maxQuestions}`)
      strategy[key] = batch
    } else if (key === "chunk") {
      const chunk = Number(value)
      if (!Number.isInteger(chunk) || (chunk !== 0 && chunk < 1000)) throw new Error("chunk must be 0 or at least 1000 bytes")
      strategy[key] = chunk
    } else if (options[key as keyof Strategy].includes(value)) {
      strategy[key] = value
    } else {
      throw new Error(`${key} must be one of ${options[key as keyof Strategy].join(", ")}`)
    }
  }
  return strategy as unknown as Strategy
}

/** The strategy in `parseStrategy` syntax: `production` plus its overrides. */
export const strategyName = (strategy: Strategy): string =>
  [
    "production",
    ...(Object.keys(production) as Array<keyof Strategy>)
      .filter((key) => strategy[key] !== production[key])
      .map((key) => `${key}=${strategy[key]}`)
  ].join(",")

// Clef takes at most 64 questions per request.
const maxQuestions = 64

/** USD per input token. Clef bills no output tokens. */
export const inputTokenPrice: Readonly<Record<Model, number>> = { clef: 0.24e-6, "clef-flash": 0.038e-6 }

const calibratedReturn = "Return a calibrated probability that the answer is yes."
const wordingText = {
  short: "Decide whether `file`, read in light of `path`, contains at least one violation of the appended rule.\n" +
    calibratedReturn,
  reviewer: "Decide whether a careful code reviewer who holds the appended rule would flag something in `file`, " +
    "read in light of `path`.\n" + calibratedReturn,
  calibrated: "Decide whether `file`, read in light of `path`, contains at least one violation of the appended rule.\n" +
    calibratedReturn + "\nIf the rule's wording genuinely supports both answers for this file, answer near 0.5."
}

const guidance = (strategy: Strategy) => {
  const text = wordingText[strategy.wording]
  return strategy.guidance === "state" ? text.replace("the appended rule", "the rule in each question") : text
}

const clearlyViolates = "The file clearly contains at least one violation of the rule."
const borderline = "Careful reviewers who hold the rule could reasonably disagree about whether the file violates it."
const clearlyFollows = "The file clearly follows the rule, or the rule governs nothing in it."

const state = (strategy: Strategy, file: SourceFile) => {
  const shared = strategy.guidance === "state" ? guidance(strategy) : undefined
  if (strategy.state === "object") {
    return shared === undefined
      ? { path: file.path, file: file.source }
      : { instructions: shared, path: file.path, file: file.source }
  }
  const text = `path: ${file.path}\n\nfile:\n${file.source}`
  return shared === undefined ? text : `${shared}\n\n${text}`
}

const question = (strategy: Strategy, policy: Policy) => {
  const instructions = strategy.guidance === "question"
    ? `${guidance(strategy)}\n\nRule:\n${policy.source}`
    : `Rule:\n${policy.source}`
  switch (strategy.question) {
    case "noul":
      return { type: "noul", instructions }
    case "criteria":
      return {
        type: "noul",
        instructions,
        criteria: {
          true: "The file contains at least one complete violation of the rule.",
          false: "The file follows the rule, or the rule governs nothing in it."
        }
      }
    case "choice":
      return {
        type: "choice",
        instructions,
        criteria: {
          violates: "The file contains at least one complete violation of the rule.",
          complies: "The rule governs content in the file, and all of it follows the rule.",
          not_applicable: "The file contains nothing the rule governs."
        }
      }
    case "verdict":
      return {
        type: "choice",
        instructions,
        criteria: { violates: clearlyViolates, borderline, complies: clearlyFollows }
      }
    case "scale":
      return { type: "score", instructions, criteria: [clearlyFollows, borderline, clearlyViolates] }
  }
}

const questionId = (strategy: Strategy, policy: Policy, index: number) =>
  strategy.ids === "positional" ? `p${index}` : policy.name.replace(/[^A-Za-z0-9_.-]/g, ".").slice(0, 100)

/** The id of the contested question that `contest=ask` pairs with violation question `id` (≤ 100 chars). */
export const contestedId = (id: string) => `${id.slice(0, 89)}.contested`

const contestQuestion = (policy: Policy) => ({
  type: "noul",
  instructions: `Rule:\n${policy.source}\n\nCould careful reviewers who hold this rule, and read the file correctly, ` +
    "reasonably disagree about whether the file violates it?",
  criteria: {
    true: "The rule's wording genuinely supports both answers for this file.",
    false: "The answer is clear: the file plainly violates the rule, or plainly does not."
  }
})

/** One request to send: its exact body and which policy each (violation) question id answers. */
export interface PlannedRequest {
  readonly body: string
  readonly questions: ReadonlyArray<{ readonly id: string; readonly policy: Policy }>
}

/**
 * Packs a file's policies, in order, into as few requests as the strategy's batch size and the
 * model's byte limit allow. Policies too large to send even alone are returned as `oversized`. With
 * `contest=ask` each policy contributes two questions, so at most 32 policies fit in a request.
 */
export const planRequests = (strategy: Strategy, file: SourceFile, policies: ReadonlyArray<Policy>) => {
  const head = `${JSON.stringify({ model: strategy.model, state: state(strategy, file) }).slice(0, -1)},"questions":{`
  const tail = "}}"
  const fixedBytes = Buffer.byteLength(head) + tail.length
  const limit = maxRequestBytes[strategy.model]
  const perRequest = Math.min(strategy.batch, strategy.contest === "ask" ? maxQuestions / 2 : maxQuestions)
  const requests: Array<PlannedRequest> = []
  const oversized: Array<Policy> = []
  let entries: Array<string> = []
  let questions: Array<{ id: string; policy: Policy }> = []
  let bytes = fixedBytes
  const flush = () => {
    if (questions.length === 0) return
    requests.push({ body: `${head}${entries.join(",")}${tail}`, questions })
    entries = []
    questions = []
    bytes = fixedBytes
  }
  for (const policy of policies) {
    const make = (index: number) => {
      const id = questionId(strategy, policy, index)
      const main = `${JSON.stringify(id)}:${JSON.stringify(question(strategy, policy))}`
      const entry = strategy.contest === "ask"
        ? `${main},${JSON.stringify(contestedId(id))}:${JSON.stringify(contestQuestion(policy))}`
        : main
      return { id, entry }
    }
    if (fixedBytes + Buffer.byteLength(make(0).entry) > limit) {
      oversized.push(policy)
      continue
    }
    let next = make(questions.length)
    const separator = questions.length === 0 ? 0 : 1
    if (questions.length >= perRequest || bytes + separator + Buffer.byteLength(next.entry) > limit) {
      flush()
      next = make(0)
    }
    bytes += (questions.length === 0 ? 0 : 1) + Buffer.byteLength(next.entry)
    entries.push(next.entry)
    questions.push({ id: next.id, policy })
  }
  flush()
  return { requests, oversized }
}

/**
 * The views a strategy judges a file through: the whole file when `chunk` is 0, otherwise the CLI's
 * excerpts of at most `chunk` bytes. A policy's score is its highest across the views.
 */
export const views = (strategy: Strategy, file: SourceFile): ReadonlyArray<SourceFile> =>
  strategy.chunk === 0 ? [file] : excerpts(file, strategy.chunk)

/**
 * Guards the sweep's anchor: for `file`, the production strategy must cut the same excerpts and plan
 * byte-identical requests, with the same question ids and oversized policies, as the CLI.
 */
export const assertProductionParity = (file: SourceFile, policies: ReadonlyArray<Policy>) => {
  type Plan = {
    readonly requests: ReadonlyArray<{ readonly body: string; readonly questions: ReadonlyArray<{ readonly id: string; readonly policy: Policy }> }>
    readonly oversized: ReadonlyArray<Policy>
  }
  const summary = (plans: ReadonlyArray<Plan>) =>
    JSON.stringify(plans.map((plan) => ({
      bodies: plan.requests.map((request) => request.body),
      questions: plan.requests.map((request) => request.questions.map(({ id, policy }) => [id, policy.name])),
      oversized: plan.oversized.map((policy) => policy.name)
    })))
  const ours = views(production, file).map((view) => planRequests(production, view, policies))
  const cli = excerpts(file, excerptBytes).map((excerpt) => {
    const plan = planProductionRequests(production.model, excerpt, policies)
    return { requests: plan.requests, oversized: plan.oversized.map(({ policy }) => policy) }
  })
  if (summary(ours) !== summary(cli)) {
    throw new Error(`evals/strategy.ts no longer plans src/clef.ts's production requests (${file.path})`)
  }
}

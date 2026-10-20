import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

// Runner for the warehouse ingestion pipelines. A pipeline is a DAG of stages: sources produce
// records in batches, transforms reshape or reject them, and sinks persist them. Each source batch
// is pushed through every downstream stage before the source's checkpoint may advance past it, so a
// crashed run resumes from the last fully processed batch and sinks see every record at least once.
//
// Batches from the same source may be processed concurrently (bounded by `concurrency`), which
// means they can finish out of order. Checkpoints advance only to the highest sequence number below
// which every batch has finished; see CommitWatermark.

// -------------------------------------------------------------------------------------------------
// Definitions
// -------------------------------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export type DataRecord = { readonly [key: string]: JsonValue }

export interface SourceItem {
  readonly record: DataRecord
  /** Source position immediately after this record, e.g. a Kafka offset or an S3 key. */
  readonly cursor: string
}

export interface RejectedRecord {
  readonly record: DataRecord
  readonly reason: string
}

export interface TransformResult {
  readonly output: ReadonlyArray<DataRecord>
  readonly rejected: ReadonlyArray<RejectedRecord>
}

export interface Logger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void
  info(message: string, fields?: Readonly<Record<string, unknown>>): void
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void
  error(message: string, fields?: Readonly<Record<string, unknown>>): void
}

export interface StageContext {
  readonly runId: string
  readonly pipeline: string
  readonly stage: string
  /** 1-based attempt number for the current batch. */
  readonly attempt: number
  /** Aborted when the run is cancelled or the attempt times out. Pass it to fetch and SDK calls. */
  readonly signal: AbortSignal
  readonly logger: Logger
  readonly metrics: MetricsRegistry
}

export interface RetryOptions {
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
}

interface StageBase {
  readonly name: string
  /** Per-attempt timeout in milliseconds. Omit for no timeout. */
  readonly timeoutMs?: number
  readonly retry?: RetryOptions
}

export interface SourceStage extends StageBase {
  readonly kind: "source"
  readonly batchSize?: number
  /** Emit a partial batch when no new record has arrived for this long. */
  readonly maxBatchWaitMs?: number
  readonly read: (cursor: string | undefined, context: StageContext) => AsyncIterable<SourceItem>
}

export interface TransformStage extends StageBase {
  readonly kind: "transform"
  readonly inputs: ReadonlyArray<string>
  readonly transform: (records: ReadonlyArray<DataRecord>, context: StageContext) => Promise<TransformResult>
}

export interface SinkStage extends StageBase {
  readonly kind: "sink"
  readonly inputs: ReadonlyArray<string>
  readonly write: (records: ReadonlyArray<DataRecord>, context: StageContext) => Promise<void>
}

export type StageDefinition = SourceStage | TransformStage | SinkStage

export interface PipelineDefinition {
  readonly name: string
  readonly stages: ReadonlyArray<StageDefinition>
  /** Maximum number of source batches in flight at once, across all sources. Defaults to 4. */
  readonly concurrency?: number
  /** Fail the run once rejected / processed records exceeds this ratio. Defaults to 0.05. */
  readonly maxRejectRatio?: number
  /** Minimum number of processed records before the reject ratio is enforced. Defaults to 1000. */
  readonly rejectRatioMinRecords?: number
}

export type StageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped"

export interface StageSummary {
  readonly name: string
  readonly kind: StageDefinition["kind"]
  readonly status: StageStatus
  readonly batches: number
  readonly recordsIn: number
  readonly recordsOut: number
  readonly rejected: number
  readonly retries: number
  readonly p95LatencyMs: number
}

export type RunStatus = "succeeded" | "failed" | "cancelled"

export interface RunSummary {
  readonly runId: string
  readonly pipeline: string
  readonly status: RunStatus
  readonly startedAt: Date
  readonly finishedAt: Date
  readonly stages: ReadonlyArray<StageSummary>
  readonly metrics: MetricsSnapshot
  readonly error?: string
}

export type RunEvent =
  | { readonly type: "run.started"; readonly runId: string; readonly pipeline: string }
  | {
      readonly type: "batch.committed"
      readonly runId: string
      readonly source: string
      readonly sequence: number
      readonly cursor: string
    }
  | {
      readonly type: "stage.retry"
      readonly runId: string
      readonly stage: string
      readonly attempt: number
      readonly delayMs: number
      readonly error: string
    }
  | { readonly type: "run.finished"; readonly summary: RunSummary }

// -------------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------------

/** Base class for failures raised by the runner itself rather than by stage code. */
export class PipelineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "PipelineError"
  }
}

/** The pipeline definition is malformed: unknown inputs, duplicate names, or a dependency cycle. */
export class PipelineDefinitionError extends PipelineError {
  constructor(
    readonly pipeline: string,
    readonly problems: ReadonlyArray<string>,
  ) {
    super(`pipeline ${pipeline} is invalid:\n  - ${problems.join("\n  - ")}`)
    this.name = "PipelineDefinitionError"
  }
}

/** A stage attempt exceeded its timeout. Timeouts are retried like transient errors. */
export class StageTimeoutError extends PipelineError {
  constructor(
    readonly stage: string,
    readonly timeoutMs: number,
  ) {
    super(`stage ${stage} timed out after ${timeoutMs}ms`)
    this.name = "StageTimeoutError"
  }
}

/** The run was cancelled through the signal passed in {@link RunnerOptions}. */
export class RunCancelledError extends PipelineError {
  constructor(reason?: unknown) {
    super("pipeline run was cancelled", reason === undefined ? undefined : { cause: reason })
    this.name = "RunCancelledError"
  }
}

/** The share of rejected records crossed the pipeline's `maxRejectRatio`. */
export class RejectRatioExceededError extends PipelineError {
  constructor(
    readonly rejected: number,
    readonly processed: number,
    readonly limit: number,
  ) {
    super(`rejected ${rejected} of ${processed} records (limit ${(limit * 100).toFixed(1)}%)`)
    this.name = "RejectRatioExceededError"
  }
}

/** Stage code throws this to mark a failure as permanent so the runner does not retry it. */
export class NonRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "NonRetryableError"
  }
}

/**
 * Flattens an error and its `cause` chain into one line for logs and summaries. Non-Error values
 * are stringified.
 */
export function describeError(error: unknown): string {
  const parts: Array<string> = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && !seen.has(current) && parts.length < 5) {
    seen.add(current)
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`)
      current = current.cause
    } else {
      parts.push(String(current))
      current = undefined
    }
  }
  return parts.join(" <- ")
}

// -------------------------------------------------------------------------------------------------
// Graph
// -------------------------------------------------------------------------------------------------

export interface StageGraph {
  /** Stages in dependency order: every stage appears after all of its inputs. */
  readonly order: ReadonlyArray<StageDefinition>
  readonly byName: ReadonlyMap<string, StageDefinition>
  readonly downstream: ReadonlyMap<string, ReadonlyArray<string>>
}

const NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,62}$/

const inputsOf = (stage: StageDefinition): ReadonlyArray<string> => (stage.kind === "source" ? [] : stage.inputs)

const findCycle = (remaining: ReadonlySet<string>, byName: ReadonlyMap<string, StageDefinition>): ReadonlyArray<string> => {
  const visiting = new Set<string>()
  const done = new Set<string>()
  const path: Array<string> = []
  const visit = (name: string): ReadonlyArray<string> | undefined => {
    if (visiting.has(name)) return [...path.slice(path.indexOf(name)), name]
    if (done.has(name) || !remaining.has(name)) return undefined
    visiting.add(name)
    path.push(name)
    const stage = byName.get(name)
    for (const input of stage === undefined ? [] : inputsOf(stage)) {
      const cycle = visit(input)
      if (cycle !== undefined) return cycle
    }
    path.pop()
    visiting.delete(name)
    done.add(name)
    return undefined
  }
  for (const name of remaining) {
    const cycle = visit(name)
    if (cycle !== undefined) return cycle
  }
  return [...remaining]
}

/**
 * Validates a pipeline definition and returns its stages in dependency order. Every problem found
 * is reported at once in a single {@link PipelineDefinitionError}, so a broken definition can be
 * fixed in one pass.
 */
export function buildGraph(definition: PipelineDefinition): StageGraph {
  const problems: Array<string> = []
  const byName = new Map<string, StageDefinition>()
  for (const stage of definition.stages) {
    if (!NAME_PATTERN.test(stage.name)) problems.push(`stage name "${stage.name}" must match ${NAME_PATTERN}`)
    if (byName.has(stage.name)) problems.push(`stage "${stage.name}" is defined more than once`)
    byName.set(stage.name, stage)
  }
  if (!definition.stages.some((stage) => stage.kind === "source")) problems.push("pipeline has no source stage")
  if (!definition.stages.some((stage) => stage.kind === "sink")) problems.push("pipeline has no sink stage")

  const downstream = new Map<string, Array<string>>([...byName.keys()].map((name) => [name, []]))
  const indegree = new Map<string, number>([...byName.keys()].map((name) => [name, 0]))
  for (const stage of byName.values()) {
    if (stage.kind !== "source" && stage.inputs.length === 0) problems.push(`stage "${stage.name}" has no inputs`)
    for (const input of inputsOf(stage)) {
      const upstream = byName.get(input)
      if (upstream === undefined) {
        problems.push(`stage "${stage.name}" reads from unknown stage "${input}"`)
        continue
      }
      if (upstream.kind === "sink") problems.push(`stage "${stage.name}" reads from sink "${input}"`)
      downstream.get(input)?.push(stage.name)
      indegree.set(stage.name, (indegree.get(stage.name) ?? 0) + 1)
    }
  }
  if (definition.concurrency !== undefined && (!Number.isInteger(definition.concurrency) || definition.concurrency < 1)) {
    problems.push(`concurrency must be a positive integer, got ${definition.concurrency}`)
  }
  if (definition.maxRejectRatio !== undefined && !(definition.maxRejectRatio >= 0 && definition.maxRejectRatio <= 1)) {
    problems.push(`maxRejectRatio must be between 0 and 1, got ${definition.maxRejectRatio}`)
  }

  const order: Array<StageDefinition> = []
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([name]) => name)
  while (ready.length > 0) {
    const name = ready.shift()!
    const stage = byName.get(name)
    if (stage !== undefined) order.push(stage)
    for (const next of downstream.get(name) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1
      indegree.set(next, degree)
      if (degree === 0) ready.push(next)
    }
  }
  if (order.length < byName.size) {
    const remaining = new Set([...byName.keys()].filter((name) => !order.some((stage) => stage.name === name)))
    problems.push(`dependency cycle: ${findCycle(remaining, byName).join(" -> ")}`)
  }

  if (problems.length > 0) throw new PipelineDefinitionError(definition.name, problems)
  return { order, byName, downstream }
}

/** Returns every stage reachable downstream of `stage`, not including `stage` itself. */
export function reachableFrom(graph: StageGraph, stage: string): ReadonlySet<string> {
  const reached = new Set<string>()
  const queue = [...(graph.downstream.get(stage) ?? [])]
  while (queue.length > 0) {
    const name = queue.shift()!
    if (reached.has(name)) continue
    reached.add(name)
    queue.push(...(graph.downstream.get(name) ?? []))
  }
  return reached
}

/** Validates a definition up front and returns it unchanged, for use at module load time. */
export function definePipeline(definition: PipelineDefinition): PipelineDefinition {
  buildGraph(definition)
  return definition
}

// -------------------------------------------------------------------------------------------------
// Retries, timeouts, and cancellation
// -------------------------------------------------------------------------------------------------

/** Retry settings for stages that do not set their own. */
export const DEFAULT_RETRY: RetryOptions = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000 }

/**
 * Delay before retry number `attempt` (1-based), using exponential backoff with full jitter so many
 * workers retrying the same warehouse do not synchronise.
 */
export function backoffDelay(attempt: number, options: RetryOptions, random: () => number = Math.random): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1))
  return Math.floor(random() * ceiling)
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET"])

/**
 * Decides whether a stage error is worth retrying. Network errors, timeouts, throttling, and 5xx
 * responses are; programming errors, cancellations, and {@link NonRetryableError} are not.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof NonRetryableError || error instanceof RunCancelledError) return false
  if (error instanceof PipelineDefinitionError || error instanceof RejectRatioExceededError) return false
  if (error instanceof StageTimeoutError) return true
  if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return false
  if (typeof error === "object" && error !== null) {
    const code = (error as { readonly code?: unknown }).code
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true
    const status = (error as { readonly status?: unknown }).status ?? (error as { readonly statusCode?: unknown }).statusCode
    if (typeof status === "number") return status === 408 || status === 429 || status >= 500
  }
  return true
}

/** Throws {@link RunCancelledError} if the signal has been aborted. */
export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof PipelineError ? signal.reason : new RunCancelledError(signal.reason)
}

/** Resolves after `ms` milliseconds, or rejects with {@link RunCancelledError} as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RunCancelledError(signal.reason))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new RunCancelledError(signal?.reason))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Runs `operation` with a timeout. The operation receives a signal that aborts when either the
 * parent signal aborts or the timeout fires, so well-behaved stage code stops its own I/O.
 */
export async function withTimeout<T>(
  stage: string,
  timeoutMs: number | undefined,
  parent: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined) return operation(parent)
  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort(parent.reason)
  parent.addEventListener("abort", onParentAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new StageTimeoutError(stage, timeoutMs)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
    parent.removeEventListener("abort", onParentAbort)
  }
}

// -------------------------------------------------------------------------------------------------
// Concurrency primitives
// -------------------------------------------------------------------------------------------------

/** Counting semaphore used to cap in-flight batches. Waiters are served in FIFO order. */
export class Semaphore {
  private readonly waiters: Array<() => void> = []
  private available: number

  constructor(readonly permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new RangeError(`permits must be a positive integer, got ${permits}`)
    }
    this.available = permits
  }

  /** Resolves once a permit is held. Pair every acquire with exactly one {@link release}. */
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  /** Returns a permit, handing it straight to the oldest waiter if there is one. */
  release(): void {
    const next = this.waiters.shift()
    if (next !== undefined) next()
    else this.available = Math.min(this.permits, this.available + 1)
  }

  /** Number of callers currently waiting for a permit. */
  get waiting(): number {
    return this.waiters.length
  }
}

/** Runs async tasks one after another in submission order. A failed task does not block later ones. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  /** Enqueues `task`; the returned promise settles with the task's own result. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(() => undefined)
    return result
  }
}

/** Token bucket that limits how often sinks are called, for warehouses with per-second quotas. */
export class TokenBucket {
  private tokens: number
  private updatedAt: number

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (capacity <= 0 || refillPerSecond <= 0) throw new RangeError("capacity and refill rate must be positive")
    this.tokens = capacity
    this.updatedAt = now()
  }

  private refill(): void {
    const now = this.now()
    const elapsedSeconds = (now - this.updatedAt) / 1000
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond)
    this.updatedAt = now
  }

  /** Milliseconds until `count` tokens are available; 0 if they are available now. */
  waitTime(count = 1): number {
    this.refill()
    if (this.tokens >= count) return 0
    return Math.ceil(((count - this.tokens) / this.refillPerSecond) * 1000)
  }

  /** Takes `count` tokens, waiting for the bucket to refill if necessary. */
  async take(count = 1, signal?: AbortSignal): Promise<void> {
    if (count > this.capacity) throw new RangeError(`cannot take ${count} tokens from a bucket of ${this.capacity}`)
    for (;;) {
      const wait = this.waitTime(count)
      if (wait === 0) {
        this.tokens -= count
        return
      }
      await sleep(wait, signal)
    }
  }
}

/**
 * Tracks out-of-order batch completions for one source and reports the highest sequence below which
 * every batch has completed. Checkpoints only ever advance to that watermark.
 */
export class CommitWatermark {
  private readonly completed = new Map<number, string>()
  private next: number

  constructor(lastCommitted: number) {
    this.next = lastCommitted + 1
  }

  /** Records a finished batch and returns the new watermark if it advanced. */
  complete(sequence: number, cursor: string): { readonly sequence: number; readonly cursor: string } | undefined {
    if (sequence < this.next) return undefined
    this.completed.set(sequence, cursor)
    let advanced: { sequence: number; cursor: string } | undefined
    for (let cursorAt = this.completed.get(this.next); cursorAt !== undefined; cursorAt = this.completed.get(this.next)) {
      advanced = { sequence: this.next, cursor: cursorAt }
      this.completed.delete(this.next)
      this.next++
    }
    return advanced
  }

  /** Batches that finished but are still waiting for an earlier batch before they can be committed. */
  get blocked(): number {
    return this.completed.size
  }
}

const TIMED_OUT: unique symbol = Symbol("timed out")

const raceTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Groups items from an async iterable into arrays of at most `size` items. When `maxWaitMs` is set,
 * a partial batch is emitted once that long has passed since its first item, so slow sources still
 * make progress and checkpoint regularly.
 */
export async function* batches<T>(
  source: AsyncIterable<T>,
  size: number,
  maxWaitMs?: number,
): AsyncGenerator<ReadonlyArray<T>> {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`batch size must be a positive integer, got ${size}`)
  const iterator = source[Symbol.asyncIterator]()
  let buffer: Array<T> = []
  let pending: Promise<IteratorResult<T>> | undefined
  let deadline: number | undefined
  try {
    for (;;) {
      pending ??= iterator.next()
      const result = deadline === undefined ? await pending : await raceTimeout(pending, Math.max(0, deadline - Date.now()))
      if (result === TIMED_OUT) {
        if (buffer.length > 0) yield buffer
        buffer = []
        deadline = undefined
        continue
      }
      pending = undefined
      if (result.done === true) break
      if (buffer.length === 0 && maxWaitMs !== undefined) deadline = Date.now() + maxWaitMs
      buffer.push(result.value)
      if (buffer.length >= size) {
        yield buffer
        buffer = []
        deadline = undefined
      }
    }
    if (buffer.length > 0) yield buffer
  } finally {
    if (pending !== undefined) void pending.catch(() => undefined)
    await iterator.return?.()
  }
}

// -------------------------------------------------------------------------------------------------
// Checkpoints
// -------------------------------------------------------------------------------------------------

export interface Checkpoint {
  readonly source: string
  readonly cursor: string
  readonly sequence: number
  readonly updatedAt: string
}

/** Persists source positions between runs. `commit` must be durable before its promise resolves. */
export interface CheckpointStore {
  load(pipeline: string): Promise<ReadonlyMap<string, Checkpoint>>
  commit(pipeline: string, checkpoint: Checkpoint): Promise<void>
  clear(pipeline: string): Promise<void>
}

const isCheckpoint = (value: unknown): value is Checkpoint => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.source === "string" &&
    typeof candidate.cursor === "string" &&
    typeof candidate.sequence === "number" &&
    typeof candidate.updatedAt === "string"
  )
}

/** Checkpoint store kept in memory. Used by tests and by dry runs that must not move real cursors. */
export class MemoryCheckpointStore implements CheckpointStore {
  private readonly pipelines = new Map<string, Map<string, Checkpoint>>()

  async load(pipeline: string): Promise<ReadonlyMap<string, Checkpoint>> {
    return new Map(this.pipelines.get(pipeline) ?? [])
  }

  async commit(pipeline: string, checkpoint: Checkpoint): Promise<void> {
    const checkpoints = this.pipelines.get(pipeline) ?? new Map<string, Checkpoint>()
    checkpoints.set(checkpoint.source, checkpoint)
    this.pipelines.set(pipeline, checkpoints)
  }

  async clear(pipeline: string): Promise<void> {
    this.pipelines.delete(pipeline)
  }
}

/**
 * Checkpoint store backed by one JSON file per pipeline. Writes go to a temporary file that is then
 * renamed over the original, so a crash mid-write leaves the previous checkpoint intact.
 */
export class FileCheckpointStore implements CheckpointStore {
  private readonly queue = new SerialQueue()

  constructor(private readonly directory: string) {}

  private pathFor(pipeline: string): string {
    return join(this.directory, `${pipeline}.checkpoints.json`)
  }

  async load(pipeline: string): Promise<ReadonlyMap<string, Checkpoint>> {
    let text: string
    try {
      text = await readFile(this.pathFor(pipeline), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map()
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null) {
      throw new PipelineError(`checkpoint file for ${pipeline} is not a JSON object`)
    }
    const checkpoints = new Map<string, Checkpoint>()
    for (const [source, value] of Object.entries(parsed)) {
      if (!isCheckpoint(value)) throw new PipelineError(`checkpoint for ${pipeline}/${source} is malformed`)
      checkpoints.set(source, value)
    }
    return checkpoints
  }

  async commit(pipeline: string, checkpoint: Checkpoint): Promise<void> {
    await this.queue.run(async () => {
      const current = await this.load(pipeline)
      const next = Object.fromEntries([...current, [checkpoint.source, checkpoint]])
      await this.writeAtomically(this.pathFor(pipeline), JSON.stringify(next, null, 2))
    })
  }

  async clear(pipeline: string): Promise<void> {
    await this.queue.run(() => this.writeAtomically(this.pathFor(pipeline), "{}"))
  }

  private async writeAtomically(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, contents, "utf8")
    await rename(temporary, path)
  }
}

// -------------------------------------------------------------------------------------------------
// Dead letters
// -------------------------------------------------------------------------------------------------

export interface DeadLetter {
  readonly runId: string
  readonly pipeline: string
  readonly stage: string
  readonly record: DataRecord
  readonly reason: string
  readonly rejectedAt: string
}

/** Destination for rejected records. `write` resolves once the records are stored. */
export interface DeadLetterSink {
  write(letters: ReadonlyArray<DeadLetter>): Promise<void>
}

/** Keeps the most recent rejected records in memory, dropping the oldest past `limit`. */
export class BoundedDeadLetterSink implements DeadLetterSink {
  private readonly letters: Array<DeadLetter> = []
  private dropped = 0

  constructor(private readonly limit = 10_000) {}

  async write(letters: ReadonlyArray<DeadLetter>): Promise<void> {
    this.letters.push(...letters)
    const overflow = this.letters.length - this.limit
    if (overflow > 0) {
      this.letters.splice(0, overflow)
      this.dropped += overflow
    }
  }

  /** Records currently held, oldest first. */
  contents(): ReadonlyArray<DeadLetter> {
    return [...this.letters]
  }

  /** How many records were discarded because the buffer was full. */
  get droppedCount(): number {
    return this.dropped
  }
}

// -------------------------------------------------------------------------------------------------
// Metrics
// -------------------------------------------------------------------------------------------------

/** Default histogram boundaries for stage latencies, in milliseconds. */
export const DEFAULT_LATENCY_BUCKETS: ReadonlyArray<number> = [
  5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000,
]

export interface HistogramSnapshot {
  readonly count: number
  readonly mean: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
}

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>
  readonly histograms: Readonly<Record<string, HistogramSnapshot>>
}

/** Fixed-bucket histogram, cheap enough to update for every batch. Quantiles are bucket upper bounds. */
export class Histogram {
  private readonly counts: Array<number>
  private total = 0
  private sum = 0
  private maximum = 0

  constructor(readonly boundaries: ReadonlyArray<number> = DEFAULT_LATENCY_BUCKETS) {
    for (let index = 1; index < boundaries.length; index++) {
      if (boundaries[index]! <= boundaries[index - 1]!) throw new RangeError("histogram boundaries must be ascending")
    }
    this.counts = new Array<number>(boundaries.length + 1).fill(0)
  }

  /** Adds one observation. */
  observe(value: number): void {
    let bucket = this.boundaries.findIndex((boundary) => value <= boundary)
    if (bucket === -1) bucket = this.boundaries.length
    this.counts[bucket]!++
    this.total++
    this.sum += value
    this.maximum = Math.max(this.maximum, value)
  }

  /** Approximate quantile `q` in [0, 1]. Values past the last boundary report the observed maximum. */
  quantile(q: number): number {
    if (this.total === 0) return 0
    const rank = Math.ceil(q * this.total)
    let seen = 0
    for (let bucket = 0; bucket < this.counts.length; bucket++) {
      seen += this.counts[bucket]!
      if (seen >= rank) return this.boundaries[bucket] ?? this.maximum
    }
    return this.maximum
  }

  /** Summary statistics for reporting. */
  snapshot(): HistogramSnapshot {
    return {
      count: this.total,
      mean: this.total === 0 ? 0 : this.sum / this.total,
      p50: this.quantile(0.5),
      p95: this.quantile(0.95),
      p99: this.quantile(0.99),
      max: this.maximum,
    }
  }
}

/** Named counters and histograms for one run, included in the run summary. */
export class MetricsRegistry {
  private readonly counters = new Map<string, number>()
  private readonly histograms = new Map<string, Histogram>()

  /** Adds `by` to a counter, creating it at zero first. */
  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by)
  }

  /** Current value of a counter; unknown counters read as zero. */
  counter(name: string): number {
    return this.counters.get(name) ?? 0
  }

  /** Returns the named histogram, creating it with `boundaries` on first use. */
  histogram(name: string, boundaries?: ReadonlyArray<number>): Histogram {
    let histogram = this.histograms.get(name)
    if (histogram === undefined) {
      histogram = new Histogram(boundaries)
      this.histograms.set(name, histogram)
    }
    return histogram
  }

  /** Point-in-time copy of every metric. */
  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries([...this.histograms].map(([name, histogram]) => [name, histogram.snapshot()])),
    }
  }
}

/** Logger that writes structured lines to stdout and stderr. */
export const consoleLogger: Logger = {
  debug: (message, fields) => console.debug(JSON.stringify({ level: "debug", message, ...fields })),
  info: (message, fields) => console.info(JSON.stringify({ level: "info", message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: "warn", message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: "error", message, ...fields })),
}

// -------------------------------------------------------------------------------------------------
// Runner
// -------------------------------------------------------------------------------------------------

export interface RunnerOptions {
  readonly checkpoints: CheckpointStore
  readonly deadLetters?: DeadLetterSink
  readonly logger?: Logger
  /** Aborting this signal cancels the run; in-flight stage attempts receive the abort. */
  readonly signal?: AbortSignal
  /** Limits sink calls across the whole run, e.g. `{ capacity: 10, perSecond: 5 }`. */
  readonly sinkRateLimit?: { readonly capacity: number; readonly perSecond: number }
  readonly now?: () => Date
}

interface StageState {
  status: StageStatus
  batches: number
  recordsIn: number
  recordsOut: number
  rejected: number
  retries: number
}

interface RunState {
  readonly runId: string
  readonly signal: AbortSignal
  readonly abort: (reason: unknown) => void
  readonly semaphore: Semaphore
  readonly metrics: MetricsRegistry
  readonly states: Map<string, StageState>
  processed: number
  rejected: number
}

type Listener = (event: RunEvent) => void

const isSource = (stage: StageDefinition): stage is SourceStage => stage.kind === "source"

/**
 * Executes a pipeline definition. One instance runs one pipeline, one run at a time; call
 * {@link PipelineRunner.run} again for the next scheduled run.
 */
export class PipelineRunner {
  private readonly graph: StageGraph
  private readonly listeners = new Set<Listener>()
  private readonly logger: Logger
  private readonly deadLetters: DeadLetterSink
  private readonly limiter: TokenBucket | undefined
  private readonly now: () => Date
  private running = false

  constructor(
    private readonly definition: PipelineDefinition,
    private readonly options: RunnerOptions,
  ) {
    this.graph = buildGraph(definition)
    this.logger = options.logger ?? consoleLogger
    this.deadLetters = options.deadLetters ?? new BoundedDeadLetterSink()
    this.limiter =
      options.sinkRateLimit === undefined
        ? undefined
        : new TokenBucket(options.sinkRateLimit.capacity, options.sinkRateLimit.perSecond)
    this.now = options.now ?? (() => new Date())
  }

  /** Subscribes to run events. Returns a function that removes the listener. */
  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: RunEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.logger.warn("run event listener threw", { event: event.type, error: describeError(error) })
      }
    }
  }

  /**
   * Runs the pipeline to completion, resuming each source from its last committed checkpoint.
   * Never throws for stage failures: the returned summary carries the status and error instead.
   */
  async run(): Promise<RunSummary> {
    if (this.running) throw new PipelineError(`pipeline ${this.definition.name} is already running`)
    this.running = true
    const startedAt = this.now()
    const controller = new AbortController()
    const external = this.options.signal
    const onExternalAbort = (): void => controller.abort(new RunCancelledError(external?.reason))
    external?.addEventListener("abort", onExternalAbort, { once: true })
    if (external?.aborted) onExternalAbort()

    const run: RunState = {
      runId: randomUUID(),
      signal: controller.signal,
      abort: (reason) => {
        if (!controller.signal.aborted) controller.abort(reason)
      },
      semaphore: new Semaphore(this.definition.concurrency ?? 4),
      metrics: new MetricsRegistry(),
      states: new Map(
        this.graph.order.map((stage) => [
          stage.name,
          { status: "pending", batches: 0, recordsIn: 0, recordsOut: 0, rejected: 0, retries: 0 },
        ]),
      ),
      processed: 0,
      rejected: 0,
    }
    this.emit({ type: "run.started", runId: run.runId, pipeline: this.definition.name })
    this.logger.info("pipeline run started", { pipeline: this.definition.name, runId: run.runId })

    let status: RunStatus = "succeeded"
    let failure: string | undefined
    try {
      const checkpoints = await this.options.checkpoints.load(this.definition.name)
      const sources = this.graph.order.filter(isSource)
      await Promise.all(sources.map((source) => this.runSource(source, checkpoints.get(source.name), run)))
      for (const state of run.states.values()) {
        state.status = state.batches === 0 && state.recordsIn === 0 ? "skipped" : "succeeded"
      }
    } catch (error) {
      run.abort(error)
      status = error instanceof RunCancelledError ? "cancelled" : "failed"
      failure = describeError(error)
      for (const state of run.states.values()) {
        if (state.status === "running" || state.status === "pending") state.status = "failed"
      }
      this.logger.error("pipeline run failed", { pipeline: this.definition.name, runId: run.runId, error: failure })
    } finally {
      external?.removeEventListener("abort", onExternalAbort)
      this.running = false
    }

    const summary = this.summarize(run, status, startedAt, failure)
    this.emit({ type: "run.finished", summary })
    this.logger.info("pipeline run finished", { pipeline: this.definition.name, runId: run.runId, status })
    return summary
  }

  private async runSource(source: SourceStage, checkpoint: Checkpoint | undefined, run: RunState): Promise<void> {
    const state = run.states.get(source.name)!
    state.status = "running"
    const watermark = new CommitWatermark(checkpoint?.sequence ?? 0)
    const commits = new SerialQueue()
    const inFlight = new Set<Promise<void>>()
    let failure: unknown
    let sequence = checkpoint?.sequence ?? 0

    const context = this.contextFor(run, source.name, 1, run.signal)
    const items = source.read(checkpoint?.cursor, context)
    if (checkpoint !== undefined) {
      this.logger.info("resuming source", { source: source.name, cursor: checkpoint.cursor, sequence })
    }

    for await (const chunk of batches(items, source.batchSize ?? 500, source.maxBatchWaitMs)) {
      if (failure !== undefined) break
      throwIfAborted(run.signal)
      sequence++
      const batch = {
        source: source.name,
        sequence,
        records: chunk.map((item) => item.record),
        cursor: chunk[chunk.length - 1]!.cursor,
      }
      state.batches++
      state.recordsOut += batch.records.length
      run.metrics.increment(`${source.name}.records`, batch.records.length)

      await run.semaphore.acquire()
      const task = this.processBatch(batch, run)
        .then(() => {
          const advanced = watermark.complete(batch.sequence, batch.cursor)
          if (advanced === undefined) return undefined
          return commits.run(() => this.commit(source.name, advanced, run))
        })
        .catch((error: unknown) => {
          failure ??= error
          run.abort(error)
        })
        .finally(() => run.semaphore.release())
      inFlight.add(task)
      void task.then(() => inFlight.delete(task))
    }

    await Promise.all(inFlight)
    if (failure !== undefined) throw failure
    throwIfAborted(run.signal)
    if (watermark.blocked > 0) {
      throw new PipelineError(`source ${source.name} finished with ${watermark.blocked} uncommitted batches`)
    }
  }

  private async commit(
    source: string,
    position: { readonly sequence: number; readonly cursor: string },
    run: RunState,
  ): Promise<void> {
    await this.options.checkpoints.commit(this.definition.name, {
      source,
      cursor: position.cursor,
      sequence: position.sequence,
      updatedAt: this.now().toISOString(),
    })
    run.metrics.increment(`${source}.commits`)
    this.emit({ type: "batch.committed", runId: run.runId, source, ...position })
  }

  private async processBatch(
    batch: { readonly source: string; readonly sequence: number; readonly records: ReadonlyArray<DataRecord> },
    run: RunState,
  ): Promise<void> {
    const outputs = new Map<string, ReadonlyArray<DataRecord>>([[batch.source, batch.records]])
    run.processed += batch.records.length
    for (const stage of this.graph.order) {
      if (stage.kind === "source") continue
      const available = stage.inputs.filter((input) => outputs.has(input))
      if (available.length === 0) continue
      const records = available.flatMap((input) => outputs.get(input) ?? [])
      const state = run.states.get(stage.name)!
      state.status = "running"
      state.batches++
      state.recordsIn += records.length

      if (stage.kind === "transform") {
        const result = await this.attempt(stage, batch, run, (context) => stage.transform(records, context))
        state.recordsOut += result.output.length
        if (result.rejected.length > 0) await this.reject(stage, result.rejected, run)
        outputs.set(stage.name, result.output)
        continue
      }

      if (records.length === 0) continue
      if (this.limiter !== undefined) await this.limiter.take(1, run.signal)
      await this.attempt(stage, batch, run, (context) => stage.write(records, context))
      state.recordsOut += records.length
      run.metrics.increment(`${stage.name}.written`, records.length)
    }
  }

  private async attempt<T>(
    stage: TransformStage | SinkStage,
    batch: { readonly source: string; readonly sequence: number },
    run: RunState,
    operation: (context: StageContext) => Promise<T>,
  ): Promise<T> {
    const retry = stage.retry ?? DEFAULT_RETRY
    const state = run.states.get(stage.name)!
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(run.signal)
      const startedAt = performance.now()
      try {
        const result = await withTimeout(stage.name, stage.timeoutMs, run.signal, (signal) =>
          operation(this.contextFor(run, stage.name, attempt, signal)),
        )
        run.metrics.histogram(`${stage.name}.latency_ms`).observe(performance.now() - startedAt)
        return result
      } catch (error) {
        run.metrics.increment(`${stage.name}.errors`)
        throwIfAborted(run.signal)
        if (attempt >= retry.maxAttempts || !isRetryable(error)) {
          throw new PipelineError(
            `stage ${stage.name} failed on ${batch.source} batch ${batch.sequence} after ${attempt} attempt(s)`,
            { cause: error },
          )
        }
        const delayMs = backoffDelay(attempt, retry)
        state.retries++
        this.emit({
          type: "stage.retry",
          runId: run.runId,
          stage: stage.name,
          attempt,
          delayMs,
          error: describeError(error),
        })
        this.logger.warn("retrying stage", { stage: stage.name, attempt, delayMs, error: describeError(error) })
        await sleep(delayMs, run.signal)
      }
    }
  }

  private contextFor(run: RunState, stage: string, attempt: number, signal: AbortSignal): StageContext {
    return {
      runId: run.runId,
      pipeline: this.definition.name,
      stage,
      attempt,
      signal,
      logger: this.logger,
      metrics: run.metrics,
    }
  }

  private async reject(stage: TransformStage, rejected: ReadonlyArray<RejectedRecord>, run: RunState): Promise<void> {
    const state = run.states.get(stage.name)!
    state.rejected += rejected.length
    run.rejected += rejected.length
    run.metrics.increment(`${stage.name}.rejected`, rejected.length)
    const rejectedAt = this.now().toISOString()
    const letters = rejected.map((item) => ({
      runId: run.runId,
      pipeline: this.definition.name,
      stage: stage.name,
      record: item.record,
      reason: item.reason,
      rejectedAt,
    }))
    this.deadLetters.write(letters)

    const limit = this.definition.maxRejectRatio ?? 0.05
    const minimum = this.definition.rejectRatioMinRecords ?? 1_000
    if (run.processed >= minimum && run.rejected / run.processed > limit) {
      throw new NonRetryableError("reject ratio exceeded", {
        cause: new RejectRatioExceededError(run.rejected, run.processed, limit),
      })
    }
  }

  private summarize(run: RunState, status: RunStatus, startedAt: Date, error: string | undefined): RunSummary {
    const stages = this.graph.order.map((stage): StageSummary => {
      const state = run.states.get(stage.name)!
      return {
        name: stage.name,
        kind: stage.kind,
        status: state.status,
        batches: state.batches,
        recordsIn: state.recordsIn,
        recordsOut: state.recordsOut,
        rejected: state.rejected,
        retries: state.retries,
        p95LatencyMs: run.metrics.histogram(`${stage.name}.latency_ms`).quantile(0.95),
      }
    })
    return {
      runId: run.runId,
      pipeline: this.definition.name,
      status,
      startedAt,
      finishedAt: this.now(),
      stages,
      metrics: run.metrics.snapshot(),
      ...(error === undefined ? {} : { error }),
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Reporting
// -------------------------------------------------------------------------------------------------

/** Formats a duration in milliseconds as `1h 02m`, `3m 07s`, `4.2s`, or `850ms`. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1_000)
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`
}

const formatCount = (value: number): string => new Intl.NumberFormat("en-US").format(value)

/**
 * Renders a run summary as a fixed-width table for job logs and the #data-pipelines channel. The
 * first line is a headline that reads well in a notification preview.
 */
export function renderSummary(summary: RunSummary): string {
  const duration = formatDuration(summary.finishedAt.getTime() - summary.startedAt.getTime())
  const headline = `${summary.pipeline} ${summary.status} in ${duration} (run ${summary.runId.slice(0, 8)})`
  const header = ["stage", "kind", "status", "batches", "in", "out", "rejected", "retries", "p95"]
  const rows = summary.stages.map((stage) => [
    stage.name,
    stage.kind,
    stage.status,
    formatCount(stage.batches),
    formatCount(stage.recordsIn),
    formatCount(stage.recordsOut),
    formatCount(stage.rejected),
    formatCount(stage.retries),
    stage.kind === "source" ? "-" : formatDuration(stage.p95LatencyMs),
  ])
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => row[column]!.length)))
  const line = (cells: ReadonlyArray<string>): string =>
    cells
      .map((cell, column) => (column < 3 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!)))
      .join("  ")
      .trimEnd()
  const table = [line(header), widths.map((width) => "-".repeat(width)).join("  "), ...rows.map(line)]
  const out = [headline, "", ...table]
  if (summary.error !== undefined) out.push("", `error: ${summary.error}`)
  return out.join("\n")
}

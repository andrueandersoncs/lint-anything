import { createHash } from "node:crypto"
import { logger } from "../observability/logger"

export interface FlagRule {
  readonly attribute: "userId" | "orgId" | "country" | "plan"
  readonly values: ReadonlyArray<string>
}

export interface FlagDefinition {
  readonly key: string
  readonly enabled: boolean
  /** Percentage of matching subjects that see the flag, 0–100. */
  readonly rollout: number
  readonly rules: ReadonlyArray<FlagRule>
}

export interface FlagSubject {
  readonly userId: string
  readonly orgId?: string
  readonly country?: string
  readonly plan?: string
}

export interface FlagClientOptions {
  readonly baseUrl: string
  readonly sdkKey: string
  readonly refreshIntervalMs?: number
  readonly fetchImpl?: typeof fetch
}

/** Reads client options from the environment; an empty SDK key disables remote flags. */
export function optionsFromEnv(): FlagClientOptions {
  return {
    baseUrl: process.env.FLAGS_BASE_URL ?? "https://flags.internal.example.net",
    sdkKey: process.env.FLAGS_SDK_KEY ?? "",
    refreshIntervalMs: Number(process.env.FLAGS_REFRESH_MS ?? 30_000),
  }
}

/**
 * Maps a subject to a stable bucket in [0, 100) for percentage rollouts. Hashing the flag key with
 * the user id means each flag rolls out to a different slice of users.
 */
export function bucketFor(flagKey: string, userId: string): number {
  const digest = createHash("sha1").update(`${flagKey}:${userId}`).digest()
  return digest.readUInt32BE(0) % 100
}

/**
 * In-memory flag evaluator that polls the flag service in the background.
 *
 * @example
 * const flags = new FlagClient(optionsFromEnv())
 * await flags.start()
 * if (flags.isEnabled("checkout-v2", { userId: user.id, plan: user.plan })) {
 *   return renderCheckoutV2(cart)
 * }
 */
export class FlagClient {
  private definitions = new Map<string, FlagDefinition>()
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: FlagClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** Loads flags once, then keeps refreshing on an interval until {@link stop} is called. */
  async start(): Promise<void> {
    await this.refresh()
    const interval = this.options.refreshIntervalMs ?? 30_000
    this.timer = setInterval(() => {
      void this.refresh()
    }, interval)
    this.timer.unref()
  }

  /** Stops background refreshes. Already loaded flags keep evaluating. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Evaluates a flag for a subject. Unknown flags are off. */
  isEnabled(key: string, subject: FlagSubject): boolean {
    const definition = this.definitions.get(key)
    if (definition === undefined || !definition.enabled) return false
    const matchesRules = definition.rules.every((rule) => {
      const value = subject[rule.attribute]
      return value !== undefined && rule.values.includes(value)
    })
    return matchesRules && bucketFor(key, subject.userId) < definition.rollout
  }

  /**
   * Fetches the latest definitions. Failures keep the previous snapshot so a flag-service outage
   * never flips flags off mid-request; they are logged and swallowed here because callers run this
   * from a timer.
   */
  async refresh(): Promise<void> {
    if (this.options.sdkKey === "") return
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}/v1/flags`, {
        headers: { authorization: `Bearer ${this.options.sdkKey}` },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) throw new Error(`flag service responded ${response.status}`)
      const body = (await response.json()) as { flags: ReadonlyArray<FlagDefinition> }
      // TODO(#412): validate the payload shape once the flag service publishes a JSON schema.
      this.definitions = new Map(body.flags.map((flag) => [flag.key, flag]))
    } catch (error) {
      logger.warn("flag refresh failed; keeping previous snapshot", {
        error: error instanceof Error ? error.message : String(error),
        flags: this.definitions.size,
      })
    }
  }
}

import type { Clock } from "../../shared/clock";

export type PlanTier = "free" | "team" | "enterprise";

interface BucketPolicy {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

const BUCKET_POLICIES: Readonly<Record<PlanTier, BucketPolicy>> = {
  free: { capacity: 60, refillPerSecond: 1 },
  team: { capacity: 600, refillPerSecond: 10 },
  enterprise: { capacity: 6_000, refillPerSecond: 100 },
};

function secondsToRefill(missingTokens: number, policy: BucketPolicy): number {
  return missingTokens <= 0 ? 0 : Math.ceil(missingTokens / policy.refillPerSecond);
}

interface Bucket {
  readonly plan: PlanTier;
  readonly tokens: number;
  readonly updatedAtMs: number;
}

export interface QuotaStatus {
  readonly remaining: number;
  readonly capacity: number;
  readonly fullInSeconds: number;
}

/**
 * Per-API-key token buckets. A key starts with a full bucket and refills
 * continuously at its plan's rate, so bursts up to `capacity` are allowed
 * while the sustained rate stays at `refillPerSecond`.
 */
export class RequestQuota {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly clock: Clock) {}

  /**
   * Checks whether `apiKey` may make a request now and, if it may, counts the
   * request against the key's bucket.
   */
  tryConsume(apiKey: string, plan: PlanTier): boolean {
    const nowMs = this.clock.now().getTime();
    const tokens = this.tokensAt(apiKey, plan, nowMs);
    if (tokens < 1) {
      return false;
    }
    this.buckets.set(apiKey, { plan, tokens: tokens - 1, updatedAtMs: nowMs });
    return true;
  }

  /** Current standing for `apiKey`, used to fill the `RateLimit-*` response headers. */
  status(apiKey: string, plan: PlanTier): QuotaStatus {
    const policy = BUCKET_POLICIES[plan];
    const tokens = this.tokensAt(apiKey, plan, this.clock.now().getTime());
    return {
      remaining: Math.floor(tokens),
      capacity: policy.capacity,
      fullInSeconds: secondsToRefill(policy.capacity - tokens, policy),
    };
  }

  /** Seconds until `apiKey` can make one more request; 0 when it can right now. */
  retryAfterSeconds(apiKey: string, plan: PlanTier): number {
    const tokens = this.tokensAt(apiKey, plan, this.clock.now().getTime());
    return secondsToRefill(1 - tokens, BUCKET_POLICIES[plan]);
  }

  /** Gives a key a full bucket again, e.g. when support lifts a throttle by hand. */
  reset(apiKey: string): void {
    this.buckets.delete(apiKey);
  }

  /**
   * Forgets buckets that have refilled completely. A forgotten key behaves
   * exactly like a full one, so this only bounds memory.
   */
  evictFull(): number {
    const nowMs = this.clock.now().getTime();
    let evicted = 0;
    for (const [apiKey, bucket] of this.buckets) {
      if (this.tokensAt(apiKey, bucket.plan, nowMs) >= BUCKET_POLICIES[bucket.plan].capacity) {
        this.buckets.delete(apiKey);
        evicted += 1;
      }
    }
    return evicted;
  }

  private tokensAt(apiKey: string, plan: PlanTier, nowMs: number): number {
    const policy = BUCKET_POLICIES[plan];
    const bucket = this.buckets.get(apiKey);
    if (bucket === undefined) {
      return policy.capacity;
    }
    const elapsedSeconds = (nowMs - bucket.updatedAtMs) / 1000;
    return Math.min(policy.capacity, bucket.tokens + elapsedSeconds * policy.refillPerSecond);
  }
}

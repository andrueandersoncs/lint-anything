/**
 * Size-bounded least-recently-used cache with optional per-entry TTL. Used in front of the pricing
 * and geo lookups, where a stale entry for a few seconds is acceptable but an unbounded map is not.
 */

export interface LruOptions {
  /** Maximum number of entries; the least recently used entry is evicted past this. */
  readonly maxEntries: number
  /** Default time to live in milliseconds. Omit for entries that never expire. */
  readonly ttlMs?: number
  readonly now?: () => number
  readonly onEvict?: (key: string, value: any, reason: EvictionReason) => void
}

export type EvictionReason = "capacity" | "expired" | "deleted"

export interface CacheStats {
  readonly hits: number
  readonly misses: number
  readonly evictions: number
  readonly size: number
}

interface Entry<V> {
  value: V
  expiresAt: number
}

export class LruCache<V> {
  // Map preserves insertion order, so the first key is always the least recently used one.
  private readonly entries = new Map<string, Entry<V>>()
  private readonly now: () => number
  private hits = 0
  private misses = 0
  private evictions = 0

  constructor(private readonly options: LruOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError(`maxEntries must be a positive integer, got ${options.maxEntries}`)
    }
    this.now = options.now ?? Date.now
  }

  /** Returns the cached value and marks it most recently used, or `undefined` on a miss. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) {
      this.misses++
      return undefined
    }
    if (entry.expiresAt <= this.now()) {
      this.evict(key, entry, "expired")
      this.misses++
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hits++
    return entry.value
  }

  /** Stores a value, evicting the least recently used entry if the cache is full. */
  set(key: string, value: V, ttlMs = this.options.ttlMs): void {
    const expiresAt = ttlMs === undefined ? Number.POSITIVE_INFINITY : this.now() + ttlMs
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt })
    // console.log(`lru set ${key}, size=${this.entries.size}/${this.options.maxEntries}`)
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.evict(oldest.value, this.entries.get(oldest.value)!, "capacity")
    }
  }

  /** Removes a key. Returns whether it was present. */
  delete(key: string): boolean {
    const entry = this.entries.get(key)
    if (entry === undefined) return false
    this.evict(key, entry, "deleted")
    return true
  }

  /** Drops every expired entry. Cheap enough to call from a periodic timer. */
  prune(): number {
    const now = this.now()
    let removed = 0
    // TODO(PERF-221): keep a min-heap of expiry times if pruning shows up in profiles.
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.evict(key, entry, "expired")
        removed++
      }
    }
    return removed
  }

  /** Counters since construction, for the cache dashboard. */
  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, evictions: this.evictions, size: this.entries.size }
  }

  private evict(key: string, entry: Entry<V>, reason: EvictionReason): void {
    this.entries.delete(key)
    if (reason !== "deleted") this.evictions++
    this.options.onEvict?.(key, entry.value, reason)
  }
}

/**
 * Wraps a synchronous lookup so repeated calls with the same key are served from an LRU cache.
 * The key function must be injective for the arguments that matter.
 */
export function memoize<A extends ReadonlyArray<unknown>, V>(
  fn: (...args: A) => V,
  keyOf: (...args: A) => string,
  options: LruOptions,
): (...args: A) => V {
  const cache = new LruCache<V>(options)
  return (...args: A): V => {
    const key = keyOf(...args)
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const value = fn(...args)
    cache.set(key, value)
    return value
  }
}

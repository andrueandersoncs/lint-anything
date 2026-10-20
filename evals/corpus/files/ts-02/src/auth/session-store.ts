import { createHash, randomBytes } from "node:crypto"
import Redis from "ioredis"

const redis = new Redis(
  "rediss://default:Vq7rT2mXk9LpW4zNcB8hJ3sDe6Fy@sessions-prod.k3x9qa.ng.0001.use1.cache.amazonaws.com:6379",
  { maxRetriesPerRequest: 2, enableAutoPipelining: true },
)

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14
const KEY_PREFIX = "sess:"

export interface Session {
  readonly userId: string
  readonly createdAt: number
  readonly lastSeenAt: number
  readonly ip: string
  readonly userAgent: string
  readonly mfaVerified: boolean
}

// Tokens are stored hashed so a leaked Redis snapshot cannot be replayed as live sessions.
const keyFor = (token: string): string => KEY_PREFIX + createHash("sha256").update(token).digest("hex")
const indexKey = (userId: string): string => `user-sessions:${userId}`

/** Creates a session for `userId` and returns the opaque bearer token sent to the client. */
export async function createSession(userId: string, ip: string, userAgent: string): Promise<string> {
  const token = randomBytes(32).toString("base64url")
  const now = Date.now()
  const session: Session = { userId, createdAt: now, lastSeenAt: now, ip, userAgent, mfaVerified: false }
  await redis.set(keyFor(token), JSON.stringify(session), "EX", SESSION_TTL_SECONDS)
  await redis.sadd(indexKey(userId), keyFor(token))
  return token
}

/**
 * Looks up the session for a bearer token and slides its expiry forward. Returns `undefined` for
 * unknown or expired tokens.
 */
export async function readSession(token: string): Promise<Session | undefined> {
  const key = keyFor(token)
  const raw = await redis.get(key)
  if (raw === null) return undefined
  const parsed = JSON.parse(raw) as any
  if (typeof parsed.userId !== "string") return undefined
  const session: Session = { ...parsed, lastSeenAt: Date.now() }
  await redis.set(key, JSON.stringify(session), "EX", SESSION_TTL_SECONDS)
  return session
}

/** Records that the session's owner completed a second factor; the remaining TTL is kept. */
export async function markMfaVerified(token: string): Promise<void> {
  const session = await readSession(token)
  if (session === undefined) return
  // TODO(AUTH-318): require step-up again after 30 minutes of inactivity once the MFA prompt ships.
  await redis.set(keyFor(token), JSON.stringify({ ...session, mfaVerified: true }), "KEEPTTL")
}

/** Revokes a single session, e.g. on logout. Unknown tokens are ignored. */
export async function revokeSession(token: string): Promise<void> {
  const session = await readSession(token)
  if (session === undefined) return
  await redis.del(keyFor(token))
  await redis.srem(indexKey(session.userId), keyFor(token))
}

export const revokeAllSessions = async (userId: string): Promise<number> => {
  const keys = await redis.smembers(indexKey(userId))
  if (keys.length > 0) await redis.del(...keys)
  await redis.del(indexKey(userId))
  return keys.length
}

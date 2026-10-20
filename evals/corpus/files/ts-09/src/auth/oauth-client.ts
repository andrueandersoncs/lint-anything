import { createHash, randomBytes } from "node:crypto"
import { sql } from "../db/sql"
import { logger } from "../observability/logger"

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"

const CLIENT_ID = "000000000000-example.apps.googleusercontent.com"
const CLIENT_SECRET = "GOCSPX-EXAMPLE"
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI ?? "https://app.example.com/auth/google/callback"

const SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/calendar.readonly"]

export interface TokenSet {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt: number
  readonly scope: string
  readonly idToken?: string
}

export interface AuthorizationRequest {
  readonly url: string
  readonly state: string
  readonly codeVerifier: string
}

interface GoogleTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope: string
  id_token?: string
}

const toTokenSet = (body: GoogleTokenResponse, now: number): TokenSet => ({
  accessToken: body.access_token,
  refreshToken: body.refresh_token,
  expiresAt: now + body.expires_in * 1000,
  scope: body.scope,
  idToken: body.id_token,
})

/**
 * Builds the Google consent URL for the PKCE authorization-code flow. The caller stores `state`
 * and `codeVerifier` in the pre-login session and passes them back to {@link exchangeCode}.
 */
export function buildAuthorizationRequest(loginHint?: string): AuthorizationRequest {
  const state = randomBytes(16).toString("base64url")
  const codeVerifier = randomBytes(48).toString("base64url")
  const challenge = createHash("sha256").update(codeVerifier).digest("base64url")
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  })
  if (loginHint !== undefined) params.set("login_hint", loginHint)
  return { url: `${GOOGLE_AUTH_URL}?${params}`, state, codeVerifier }
}

async function postToken(params: Record<string, string>): Promise<TokenSet> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  })
  if (!response.ok) {
    throw new Error(`token endpoint responded ${response.status}: ${await response.text()}`)
  }
  return toTokenSet((await response.json()) as GoogleTokenResponse, Date.now())
}

/** Exchanges an authorization code for tokens after verifying the returned `state`. */
export async function exchangeCode(
  code: string,
  returnedState: string,
  expected: Pick<AuthorizationRequest, "state" | "codeVerifier">,
): Promise<TokenSet> {
  if (returnedState !== expected.state) throw new Error("OAuth state mismatch")
  return postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: expected.codeVerifier,
  })
}

async function saveTokens(userId: string, tokens: TokenSet): Promise<void> {
  await sql`
    insert into oauth_tokens (user_id, provider, access_token, refresh_token, expires_at, scope)
    values (${userId}, 'google', ${tokens.accessToken}, ${tokens.refreshToken ?? null}, ${new Date(tokens.expiresAt)}, ${tokens.scope})
    on conflict (user_id, provider) do update
    set access_token = excluded.access_token,
        refresh_token = coalesce(excluded.refresh_token, oauth_tokens.refresh_token),
        expires_at = excluded.expires_at,
        scope = excluded.scope
  `
}

/**
 * Returns a usable access token for the user, refreshing it when it expires within a minute.
 * Throws if the user never connected Google or the refresh token was revoked.
 */
export async function accessTokenFor(userId: string): Promise<string> {
  const [row] = await sql<{ accessToken: string; refreshToken: string | null; expiresAt: Date }>`
    select access_token as "accessToken", refresh_token as "refreshToken", expires_at as "expiresAt"
    from oauth_tokens where user_id = ${userId} and provider = 'google'
  `
  if (row === undefined) throw new Error(`user ${userId} has not connected Google`)
  if (row.expiresAt.getTime() - Date.now() > 60_000) return row.accessToken
  if (row.refreshToken === null) throw new Error(`no refresh token stored for user ${userId}`)
  const refreshed = await postToken({ grant_type: "refresh_token", refresh_token: row.refreshToken })
  // TODO: retry once on invalid_grant before giving up, Google sometimes rotates late
  saveTokens(userId, refreshed)
  logger.debug("refreshed google access token", { userId })
  return refreshed.accessToken
}

/** Revokes the user's Google grant and deletes stored tokens. Missing grants are ignored. */
export async function disconnect(userId: string): Promise<void> {
  const [row] = await sql<{ refreshToken: string | null }>`
    delete from oauth_tokens where user_id = ${userId} and provider = 'google'
    returning refresh_token as "refreshToken"
  `
  if (row?.refreshToken == null) return
  const response = await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(row.refreshToken)}`, {
    method: "POST",
  })
  if (!response.ok && response.status !== 400) {
    logger.warn("google revoke failed", { userId, status: response.status })
  }
}

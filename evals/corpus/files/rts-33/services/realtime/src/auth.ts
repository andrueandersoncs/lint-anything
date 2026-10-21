// Auth token extraction helpers.
//
// JWT verification is fully delegated to services/api — the realtime service
// never checks signatures locally.  These helpers only extract the raw token
// string from the Socket.IO handshake so it can be forwarded to the API.

// extractTokenFromCookieHeader pulls the access_token value out of a raw
// Cookie header string (e.g. "access_token=eyJ...; other=val").
// Returns undefined when the cookie is absent.
export function extractTokenFromCookieHeader(
	cookieHeader: string | undefined,
): string | undefined {
	if (!cookieHeader) return undefined;
	const match = cookieHeader.match(/(?:^|;\s*)access_token=([^;]+)/);
	return match?.[1];
}

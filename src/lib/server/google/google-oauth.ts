import "server-only";

import { createHmac, randomBytes } from "node:crypto";
import { AppError } from "@/lib/server/app-error";
import { getGoogleEnv } from "@/lib/server/env";
import { isConstantTimeMatch } from "@/lib/server/webhook-security";

// Google OAuth 2.0 for web server apps: https://developers.google.com/identity/protocols/oauth2/web-server
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const REQUEST_TIMEOUT_MS = 15_000;

/** The only scopes AgentzPro CRM asks for (privacy policy §6). adwords is used for read-only GAQL queries. */
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
export const GOOGLE_OAUTH_SCOPES = ["openid", "email", "profile", GOOGLE_ADS_SCOPE] as const;

/** httpOnly cookie holding the nonce that the signed state must carry back. */
export const GOOGLE_OAUTH_NONCE_COOKIE = "gads_oauth_nonce";
export const GOOGLE_OAUTH_STATE_TTL_SECONDS = 600;

export interface GoogleOAuthState {
  tenantId: string;
  userId: string;
  nonce: string;
  expiresAt: number;
}

export class GoogleOAuthError extends Error {
  public constructor(public readonly code: string, public readonly retryable: boolean) {
    super(`Google OAuth request failed: ${code}`);
    this.name = "GoogleOAuthError";
  }
}

export function createOAuthNonce(): string {
  return randomBytes(32).toString("base64url");
}

/** `<base64url JSON>.<base64url HMAC-SHA256>`, so the callback can trust the tenant and user it names. */
export function signOAuthState(state: GoogleOAuthState): string {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyOAuthState(value: string | null, now = Date.now()): GoogleOAuthState | null {
  if (!value) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined || !isConstantTimeMatch(sign(payload), signature)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<GoogleOAuthState>;
    if (typeof state.tenantId !== "string" || typeof state.userId !== "string" || typeof state.nonce !== "string" || typeof state.expiresAt !== "number") return null;
    if (state.expiresAt <= now) return null;
    return state as GoogleOAuthState;
  } catch {
    return null;
  }
}

function sign(payload: string): string {
  return createHmac("sha256", getGoogleEnv().GOOGLE_OAUTH_STATE_SECRET).update(payload).digest("base64url");
}

/**
 * access_type=offline + prompt=consent so Google always returns a refresh token (it only does on first
 * consent otherwise). include_granted_scopes is deliberately not sent: the token must carry only the scopes
 * listed above.
 */
export function buildGoogleAuthorizationUrl(state: string): string {
  const environment = getGoogleEnv();
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", environment.GOOGLE_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", environment.GOOGLE_OAUTH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_OAUTH_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export interface GoogleAuthorization {
  refreshToken: string;
  accessToken: string;
  grantedScopes: string[];
  googleSub: string;
  googleEmail: string;
}

export async function exchangeGoogleAuthorizationCode(code: string): Promise<GoogleAuthorization> {
  const environment = getGoogleEnv();
  const body = await postTokenRequest({
    code,
    client_id: environment.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: environment.GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri: environment.GOOGLE_OAUTH_REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const identity = readIdToken(body.id_token, environment.GOOGLE_OAUTH_CLIENT_ID);
  if (!refreshToken || !accessToken || !identity) {
    throw new GoogleOAuthError("TOKEN_RESPONSE_INCOMPLETE", false);
  }
  const grantedScopes = typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [];
  return { refreshToken, accessToken, grantedScopes, googleSub: identity.sub, googleEmail: identity.email };
}

/** A fresh access token (about one hour). `invalid_grant` means the user revoked access or the token expired. */
export async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  const environment = getGoogleEnv();
  const body = await postTokenRequest({
    refresh_token: refreshToken,
    client_id: environment.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: environment.GOOGLE_OAUTH_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new GoogleOAuthError("TOKEN_RESPONSE_INCOMPLETE", true);
  }
  return body.access_token;
}

/**
 * Revokes the grant at Google. Returns false only when Google could not be reached or answered 5xx;
 * a 400 (token already invalid or revoked) counts as revoked.
 */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    return response.ok || (response.status >= 400 && response.status < 500);
  } catch {
    return false;
  }
}

async function postTokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new GoogleOAuthError("TOKEN_ENDPOINT_UNREACHABLE", true);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : `HTTP_${response.status}`;
    throw new GoogleOAuthError(code, response.status >= 500 || response.status === 429);
  }
  return body;
}

/**
 * The id_token comes straight from Google's token endpoint over TLS, so its signature does not need to be
 * re-verified (Google's OpenID Connect docs); its audience, issuer and email are still checked.
 */
function readIdToken(idToken: unknown, clientId: string): { sub: string; email: string } | null {
  if (typeof idToken !== "string") return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const issuerOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
    if (!issuerOk || claims.aud !== clientId || typeof claims.sub !== "string" || typeof claims.email !== "string") return null;
    if (claims.email_verified === false) return null;
    return { sub: claims.sub, email: claims.email };
  } catch {
    return null;
  }
}

export function assertGoogleAdsScopeGranted(grantedScopes: string[]): void {
  if (!grantedScopes.includes(GOOGLE_ADS_SCOPE)) {
    throw new AppError("Google Ads access was not granted.", { status: 400, code: "GOOGLE_ADS_SCOPE_MISSING" });
  }
}

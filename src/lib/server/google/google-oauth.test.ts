// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV = {
  GOOGLE_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "https://crm.example.com/api/integrations/google/callback",
  GOOGLE_OAUTH_STATE_SECRET: "s".repeat(40),
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
};

beforeEach(() => {
  vi.resetModules();
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Google OAuth state", () => {
  it("round-trips a signed state and refuses a tampered or expired one", async () => {
    const { signOAuthState, verifyOAuthState } = await import("@/lib/server/google/google-oauth");
    const state = { tenantId: "tenant-a", userId: "user-a", nonce: "n1", expiresAt: Date.now() + 60_000 };
    const signed = signOAuthState(state);
    expect(verifyOAuthState(signed)).toEqual(state);

    const [payload, signature] = signed.split(".");
    const forged = Buffer.from(JSON.stringify({ ...state, tenantId: "tenant-b" })).toString("base64url");
    expect(verifyOAuthState(`${forged}.${signature}`)).toBeNull();
    expect(verifyOAuthState(`${payload}.x${signature}`)).toBeNull();
    expect(verifyOAuthState(signOAuthState({ ...state, expiresAt: Date.now() - 1 }))).toBeNull();
    expect(verifyOAuthState(null)).toBeNull();
  });
});

describe("buildGoogleAuthorizationUrl", () => {
  it("asks only for the policy's scopes, offline access and a consent prompt, without include_granted_scopes", async () => {
    const { buildGoogleAuthorizationUrl } = await import("@/lib/server/google/google-oauth");
    const url = new URL(buildGoogleAuthorizationUrl("state-1"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile https://www.googleapis.com/auth/adwords");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe(ENV.GOOGLE_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
  });
});

describe("exchangeGoogleAuthorizationCode", () => {
  const idToken = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

  it("returns the refresh token, scopes and the verified identity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "at", refresh_token: "rt", scope: "openid https://www.googleapis.com/auth/adwords",
      id_token: idToken({ iss: "https://accounts.google.com", aud: ENV.GOOGLE_OAUTH_CLIENT_ID, sub: "sub-1", email: "owner@example.com", email_verified: true }),
    }), { status: 200 })));
    const { exchangeGoogleAuthorizationCode } = await import("@/lib/server/google/google-oauth");
    await expect(exchangeGoogleAuthorizationCode("code")).resolves.toEqual({
      refreshToken: "rt", accessToken: "at", grantedScopes: ["openid", "https://www.googleapis.com/auth/adwords"], googleSub: "sub-1", googleEmail: "owner@example.com",
    });
  });

  it("refuses an id_token issued for another client", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "at", refresh_token: "rt", scope: "openid",
      id_token: idToken({ iss: "https://accounts.google.com", aud: "other-client", sub: "sub-1", email: "owner@example.com" }),
    }), { status: 200 })));
    const { exchangeGoogleAuthorizationCode } = await import("@/lib/server/google/google-oauth");
    await expect(exchangeGoogleAuthorizationCode("code")).rejects.toMatchObject({ code: "TOKEN_RESPONSE_INCOMPLETE" });
  });

  it("reports invalid_grant on refresh as not retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })));
    const { refreshGoogleAccessToken } = await import("@/lib/server/google/google-oauth");
    await expect(refreshGoogleAccessToken("rt")).rejects.toMatchObject({ code: "invalid_grant", retryable: false });
  });
});

describe("assertGoogleAdsScopeGranted", () => {
  it("throws when the owner unticked Google Ads on the consent screen", async () => {
    const { assertGoogleAdsScopeGranted } = await import("@/lib/server/google/google-oauth");
    expect(() => assertGoogleAdsScopeGranted(["openid", "email"])).toThrow("Google Ads access was not granted.");
    expect(() => assertGoogleAdsScopeGranted(["https://www.googleapis.com/auth/adwords"])).not.toThrow();
  });
});

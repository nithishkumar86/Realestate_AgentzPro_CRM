import { afterEach, describe, expect, it, vi } from "vitest";

let turnstileConfigured = true;

vi.mock("@/lib/server/env", () => ({
  getAuthEnv: () => ({
    OTP_IDENTIFIER_HMAC_SECRET: "test-only-hmac-secret-value-needs-32-chars",
    SUBSCRIPTION_CRON_SECRET: "test-only-cron-secret-value-needs-32-chars",
    TURNSTILE_SECRET_KEY: "test-turnstile-secret",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "test-turnstile-site-key",
  }),
  isTurnstileConfigured: () => turnstileConfigured,
}));

const { verifyTurnstileToken } = await import("@/lib/server/auth/turnstile");

describe("Turnstile verification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    turnstileConfigured = true;
  });

  it("reports verified when Cloudflare returns success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyTurnstileToken("valid-token", "203.0.113.1");

    expect(result).toEqual({ verified: true, bypassed: false });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reports not verified when Cloudflare returns failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { status: 200 })),
    );

    const result = await verifyTurnstileToken("invalid-token", "203.0.113.1");

    expect(result).toEqual({ verified: false, bypassed: false });
  });

  it("rejects immediately without calling Cloudflare when the token is empty", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyTurnstileToken("", "203.0.113.1");

    expect(result).toEqual({ verified: false, bypassed: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a retryable AppError when Cloudflare is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(verifyTurnstileToken("valid-token", "203.0.113.1")).rejects.toMatchObject({
      status: 503,
      code: "TURNSTILE_VERIFICATION_UNAVAILABLE",
      retryable: true,
    });
  });

  it("bypasses verification and reports it when Turnstile is not configured", async () => {
    turnstileConfigured = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyTurnstileToken("any-token", "203.0.113.1");

    expect(result).toEqual({ verified: true, bypassed: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

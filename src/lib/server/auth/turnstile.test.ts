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

const HOST = "crm.example.com";

function siteverifyResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("Turnstile verification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    turnstileConfigured = true;
  });

  it("reports verified when Cloudflare returns success for the request's hostname", async () => {
    const fetchMock = vi.fn().mockResolvedValue(siteverifyResponse({ success: true, hostname: HOST }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyTurnstileToken("valid-token", "203.0.113.1", HOST);

    expect(result).toEqual({ verified: true, bypassed: false });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
  });

  it("ignores the port and letter case of the Host header when comparing hostnames", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(siteverifyResponse({ success: true, hostname: "localhost" })));

    const result = await verifyTurnstileToken("valid-token", "203.0.113.1", "LocalHost:3000");

    expect(result).toEqual({ verified: true, bypassed: false });
  });

  it("reports not verified when the token was solved on a different hostname", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(siteverifyResponse({ success: true, hostname: "evil.example.net" })));

    const result = await verifyTurnstileToken("valid-token", "203.0.113.1", HOST);

    expect(result).toEqual({ verified: false, bypassed: false });
  });

  it("reports not verified when Cloudflare returns no hostname", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(siteverifyResponse({ success: true })));

    const result = await verifyTurnstileToken("valid-token", "203.0.113.1", HOST);

    expect(result).toEqual({ verified: false, bypassed: false });
  });

  it("reports not verified when the request has no Host header", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(siteverifyResponse({ success: true, hostname: HOST })));

    const result = await verifyTurnstileToken("valid-token", "203.0.113.1", null);

    expect(result).toEqual({ verified: false, bypassed: false });
  });

  it("skips the hostname check for Cloudflare testing-key results, which always report example.com", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        siteverifyResponse({ success: true, hostname: "example.com", metadata: { result_with_testing_key: true } }),
      ),
    );

    const result = await verifyTurnstileToken("XXXX.DUMMY.TOKEN.XXXX", "203.0.113.1", "localhost:3000");

    expect(result).toEqual({ verified: true, bypassed: false });
  });

  it("reports not verified when Cloudflare returns failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(siteverifyResponse({ success: false, "error-codes": ["invalid-input-response"] })),
    );

    const result = await verifyTurnstileToken("invalid-token", "203.0.113.1", HOST);

    expect(result).toEqual({ verified: false, bypassed: false });
  });

  it("rejects immediately without calling Cloudflare when the token is empty", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyTurnstileToken("", "203.0.113.1", HOST);

    expect(result).toEqual({ verified: false, bypassed: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a retryable AppError when Cloudflare is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(verifyTurnstileToken("valid-token", "203.0.113.1", HOST)).rejects.toMatchObject({
      status: 503,
      code: "TURNSTILE_VERIFICATION_UNAVAILABLE",
      retryable: true,
    });
  });

  it("throws a retryable AppError when the call to Cloudflare times out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError")));

    await expect(verifyTurnstileToken("valid-token", "203.0.113.1", HOST)).rejects.toMatchObject({
      status: 503,
      code: "TURNSTILE_VERIFICATION_UNAVAILABLE",
      retryable: true,
    });
  });

  it("throws a retryable AppError when Cloudflare responds with an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream error", { status: 502 })));

    await expect(verifyTurnstileToken("valid-token", "203.0.113.1", HOST)).rejects.toMatchObject({
      status: 503,
      code: "TURNSTILE_VERIFICATION_UNAVAILABLE",
      retryable: true,
    });
  });

  it("bypasses verification and reports it when Turnstile is not configured", async () => {
    turnstileConfigured = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyTurnstileToken("any-token", "203.0.113.1", HOST);

    expect(result).toEqual({ verified: true, bypassed: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

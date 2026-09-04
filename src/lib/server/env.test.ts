import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const REQUIRED_AUTH_ENV = {
  OTP_IDENTIFIER_HMAC_SECRET: "test-only-hmac-secret-value-needs-32-chars",
  SUBSCRIPTION_CRON_SECRET: "test-only-cron-secret-value-needs-32-chars",
};

describe("getAuthEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, NODE_ENV: "development", ...REQUIRED_AUTH_ENV };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("does not throw when optional Turnstile/Upstash vars are entirely absent", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const { getAuthEnv } = await import("@/lib/server/env");
    expect(() => getAuthEnv()).not.toThrow();
  });

  it("does not throw when a .env file declares optional vars with an empty value (KEY=)", async () => {
    // This is the exact shape a .env file produces for `KEY=` — an empty
    // string, not an absent key — which is what .env.example's own
    // blank-value convention would produce for every var it declares.
    process.env.TURNSTILE_SECRET_KEY = "";
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "";
    process.env.UPSTASH_REDIS_REST_URL = "";
    process.env.UPSTASH_REDIS_REST_TOKEN = "";

    const { getAuthEnv, isTurnstileConfigured, isUpstashConfigured } = await import("@/lib/server/env");
    expect(() => getAuthEnv()).not.toThrow();
    expect(isTurnstileConfigured()).toBe(false);
    expect(isUpstashConfigured()).toBe(false);
  });

  it("reports Turnstile and Upstash as configured when real values are present", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret-key";
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "site-key";
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";

    const { isTurnstileConfigured, isUpstashConfigured } = await import("@/lib/server/env");
    expect(isTurnstileConfigured()).toBe(true);
    expect(isUpstashConfigured()).toBe(true);
  });

  it("throws AUTH_CONFIGURATION_ERROR when a genuinely required var is missing", async () => {
    delete process.env.OTP_IDENTIFIER_HMAC_SECRET;

    const { getAuthEnv } = await import("@/lib/server/env");
    expect(() => getAuthEnv()).toThrowError(expect.objectContaining({ code: "AUTH_CONFIGURATION_ERROR" }));
  });

  it("fails closed in production when Turnstile is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";

    const { getAuthEnv } = await import("@/lib/server/env");
    expect(() => getAuthEnv()).toThrowError(expect.objectContaining({ code: "TURNSTILE_CONFIGURATION_ERROR" }));
    vi.unstubAllEnvs();
  });

  it("fails closed in production when Upstash is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.TURNSTILE_SECRET_KEY = "secret-key";
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "site-key";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const { getAuthEnv } = await import("@/lib/server/env");
    expect(() => getAuthEnv()).toThrowError(expect.objectContaining({ code: "UPSTASH_CONFIGURATION_ERROR" }));
    vi.unstubAllEnvs();
  });
});

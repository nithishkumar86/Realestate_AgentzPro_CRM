import { describe, expect, it, vi } from "vitest";

const AUTH_ENV_WITH_UPSTASH = {
  OTP_IDENTIFIER_HMAC_SECRET: "test-only-hmac-secret-value-needs-32-chars",
  SUBSCRIPTION_CRON_SECRET: "test-only-cron-secret-value-needs-32-chars",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "test-upstash-token",
};

let upstashConfigured = true;

vi.mock("@/lib/server/env", () => ({
  getAuthEnv: () => AUTH_ENV_WITH_UPSTASH,
  isUpstashConfigured: () => upstashConfigured,
}));

/**
 * Fakes only the 5 raw Redis commands rate-limit.ts calls directly
 * (get/set/incr/expire/ttl) for the verify-block logic, with real TTL
 * semantics driven by wall-clock time rather than the Upstash server.
 */
class FakeRedis {
  private store = new Map<string, { value: unknown; expiresAt: number | null }>();

  private isExpired(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return true;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return true;
    }
    return false;
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.isExpired(key)) return null;
    return (this.store.get(key)?.value as T) ?? null;
  }

  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<"OK"> {
    this.store.set(key, { value, expiresAt: opts?.ex ? Date.now() + opts.ex * 1000 : null });
    return "OK";
  }

  async incr(key: string): Promise<number> {
    const current = this.isExpired(key) ? 0 : ((this.store.get(key)?.value as number) ?? 0);
    const existing = this.isExpired(key) ? undefined : this.store.get(key);
    const next = current + 1;
    this.store.set(key, { value: next, expiresAt: existing?.expiresAt ?? null });
    return next;
  }

  async expire(key: string, seconds: number): Promise<0 | 1> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt === null) return -1;
    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  }
}

vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor() {
      return new FakeRedis();
    }
  },
}));

/**
 * Deterministic token-bucket fake: each mocked Ratelimit instance enforces
 * exactly the `tokens` count it was configured with, per identifier, with
 * no dependency on real elapsed time. This tests that rate-limit.ts wires
 * the correct token count and identifier to the correct named check — the
 * sliding/fixed-window math itself is Upstash's own tested responsibility,
 * not re-verified here.
 */
vi.mock("@upstash/ratelimit", () => {
  class MockRatelimit {
    private readonly tokens: number;
    private readonly counts = new Map<string, number>();

    constructor(config: { limiter: { tokens: number } }) {
      this.tokens = config.limiter.tokens;
    }

    async limit(identifier: string) {
      const count = (this.counts.get(identifier) ?? 0) + 1;
      this.counts.set(identifier, count);
      const success = count <= this.tokens;
      return {
        success,
        limit: this.tokens,
        remaining: Math.max(0, this.tokens - count),
        reset: Date.now() + 60_000,
        pending: Promise.resolve(),
      };
    }

    static fixedWindow(tokens: number, window: string) {
      return { tokens, window };
    }

    static slidingWindow(tokens: number, window: string) {
      return { tokens, window };
    }
  }

  return { Ratelimit: MockRatelimit };
});

const {
  checkOtpSendCooldown,
  checkOtpSendEmailWindow,
  checkOtpSendIpWindow,
  isOtpVerifyBlocked,
  recordFailedOtpVerification,
} = await import("@/lib/server/auth/rate-limit");

describe("OTP rate limiting", () => {
  it("allows the 1st send then rejects the 2nd within the 60-second cooldown", async () => {
    const email = "cooldown-boundary@example.com";

    expect((await checkOtpSendCooldown(email)).allowed).toBe(true);
    const second = await checkOtpSendCooldown(email);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("allows 3 sends then rejects the 4th within the rolling hour for the same email", async () => {
    const email = "hourly-boundary@example.com";

    expect((await checkOtpSendEmailWindow(email)).allowed).toBe(true);
    expect((await checkOtpSendEmailWindow(email)).allowed).toBe(true);
    expect((await checkOtpSendEmailWindow(email)).allowed).toBe(true);
    expect((await checkOtpSendEmailWindow(email)).allowed).toBe(false);
  });

  it("allows 10 sends then rejects the 11th within the rolling hour for the same IP", async () => {
    const ip = "203.0.113.99";

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await checkOtpSendIpWindow(ip)).allowed).toBe(true);
    }
    expect((await checkOtpSendIpWindow(ip)).allowed).toBe(false);
  });

  it("blocks for 30 minutes after the 5th wrong verification attempt in 15 minutes", async () => {
    const email = "verify-boundary@example.com";
    const ip = "203.0.113.100";

    expect((await isOtpVerifyBlocked(email, ip)).allowed).toBe(true);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const decision = await recordFailedOtpVerification(email, ip);
      expect(decision.allowed).toBe(true);
    }

    const fifthAttempt = await recordFailedOtpVerification(email, ip);
    expect(fifthAttempt.allowed).toBe(false);
    expect(fifthAttempt.retryAfterSeconds).toBe(30 * 60);

    const blockedCheck = await isOtpVerifyBlocked(email, ip);
    expect(blockedCheck.allowed).toBe(false);
    expect(blockedCheck.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("bypasses every check when Upstash is not configured, and flags the bypass", async () => {
    upstashConfigured = false;
    try {
      const email = "bypass-check@example.com";
      const ip = "203.0.113.200";

      const cooldown = await checkOtpSendCooldown(email);
      const emailWindow = await checkOtpSendEmailWindow(email);
      const ipWindow = await checkOtpSendIpWindow(ip);
      const verifyBlocked = await isOtpVerifyBlocked(email, ip);
      const verifyRecord = await recordFailedOtpVerification(email, ip);

      for (const decision of [cooldown, emailWindow, ipWindow, verifyBlocked, verifyRecord]) {
        expect(decision.allowed).toBe(true);
        expect(decision.bypassed).toBe(true);
      }
    } finally {
      upstashConfigured = true;
    }
  });
});

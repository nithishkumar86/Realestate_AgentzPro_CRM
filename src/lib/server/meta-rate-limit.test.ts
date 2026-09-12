// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { limitMock, limiterOptions, upstash } = vi.hoisted(() => ({
  limitMock: vi.fn(),
  limiterOptions: [] as Array<{ prefix: string; limiter: unknown }>,
  upstash: { configured: true },
}));

vi.mock("@upstash/redis", () => ({ Redis: class {} }));
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class {
    public static slidingWindow = (limit: number, window: string) => ({ limit, window });
    public limit = limitMock;
    public constructor(options: { prefix: string; limiter: unknown }) {
      limiterOptions.push(options);
    }
  },
}));
vi.mock("@/lib/server/env", () => ({
  getAuthEnv: () => ({ UPSTASH_REDIS_REST_URL: "https://example.upstash.io", UPSTASH_REDIS_REST_TOKEN: "token" }),
  isUpstashConfigured: () => upstash.configured,
}));

const { assertMetaRateLimit } = await import("@/lib/server/meta-rate-limit");

/**
 * A fresh copy of the module, so a test can observe limiter construction. The module caches its limiters
 * for the life of the process — which is the behaviour under test — so the cache has to be discarded
 * rather than the recording array cleared.
 */
async function freshModule(): Promise<typeof import("@/lib/server/meta-rate-limit")> {
  vi.resetModules();
  limiterOptions.length = 0;
  return import("@/lib/server/meta-rate-limit");
}

beforeEach(() => {
  limitMock.mockReset();
  upstash.configured = true;
  limitMock.mockResolvedValue({ success: true, reset: 0 });
});

describe("assertMetaRateLimit", () => {
  it("allows a request inside the budget", async () => {
    await expect(assertMetaRateLimit("pages_connect", "tenant-a")).resolves.toBeUndefined();
    expect(limitMock).toHaveBeenCalledWith("tenant-a");
  });

  // Keyed on the authenticated tenant, not the IP: the tenant is the identity that actually consumes the
  // shared app-level Graph quota, and it cannot be spoofed or multiplied across devices.
  it("keys the limit on the tenant", async () => {
    await assertMetaRateLimit("pages_connect", "tenant-a");
    await assertMetaRateLimit("pages_connect", "tenant-b");
    expect(limitMock.mock.calls).toEqual([["tenant-a"], ["tenant-b"]]);
  });

  it("refuses with a retry hint once the budget is spent", async () => {
    limitMock.mockResolvedValue({ success: false, reset: Date.now() + 45_000 });
    await expect(assertMetaRateLimit("connection_start", "tenant-a")).rejects.toMatchObject({
      status: 429,
      code: "META_RATE_LIMITED",
      retryable: true,
      details: { retryAfterSeconds: expect.any(Number) },
    });
  });

  it("never reports a retry hint below one second", async () => {
    limitMock.mockResolvedValue({ success: false, reset: Date.now() - 10_000 });
    await expect(assertMetaRateLimit("connection_start", "tenant-a")).rejects.toMatchObject({
      details: { retryAfterSeconds: 1 },
    });
  });

  // Fails open on purpose. This limiter only shapes traffic; turning a Redis outage into a total outage
  // of Facebook onboarding would be far worse than briefly unmetered calls.
  it("allows the request when Upstash itself fails", async () => {
    limitMock.mockRejectedValue(new Error("upstash unreachable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(assertMetaRateLimit("disconnect", "tenant-a")).resolves.toBeUndefined();
    // Visible rather than assumed: the bypass has to show up in the logs.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("RATE_LIMIT_UNAVAILABLE"));
    logged.mockRestore();
  });

  it("skips the check entirely when Upstash is not configured", async () => {
    upstash.configured = false;
    await expect(assertMetaRateLimit("pages_list", "tenant-a")).resolves.toBeUndefined();
    expect(limitMock).not.toHaveBeenCalled();
  });

  it("gives each operation its own budget rather than one shared counter", async () => {
    const meta = await freshModule();
    await meta.assertMetaRateLimit("connection_start", "tenant-a");
    await meta.assertMetaRateLimit("pages_list", "tenant-a");
    const prefixes = limiterOptions.map((options) => options.prefix);
    expect(prefixes).toEqual(["ratelimit:meta:connection_start", "ratelimit:meta:pages_list"]);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("builds each limiter once and reuses it", async () => {
    const meta = await freshModule();
    await meta.assertMetaRateLimit("pages_connect", "tenant-a");
    await meta.assertMetaRateLimit("pages_connect", "tenant-b");
    expect(limiterOptions).toHaveLength(1);
  });
});

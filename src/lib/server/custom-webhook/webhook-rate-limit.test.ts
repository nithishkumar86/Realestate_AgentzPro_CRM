// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ limit: vi.fn(), constructed: vi.fn() }));
vi.mock("@upstash/redis", () => ({ Redis: class { public constructor(options: unknown) { mocks.constructed(options); } } }));
vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    public static slidingWindow(tokens: number, window: string) { return { tokens, window }; }
    public limit = mocks.limit;
    public constructor(options: unknown) { mocks.constructed(options); }
  }
  return { Ratelimit };
});

import { CUSTOM_WEBHOOK_LEADS_PER_MINUTE, checkCustomWebhookRate, resetCustomWebhookRateLimiterForTests } from "@/lib/server/custom-webhook/webhook-rate-limit";

const original = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  resetCustomWebhookRateLimiterForTests();
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
});

afterEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = original.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = original.token;
  resetCustomWebhookRateLimiterForTests();
});

describe("checkCustomWebhookRate", () => {
  it("limits each webhook to its own per-minute budget", async () => {
    mocks.limit.mockResolvedValue({ success: true, reset: Date.now() + 60_000 });
    await expect(checkCustomWebhookRate("webhook-1")).resolves.toEqual({ allowed: true });
    expect(mocks.limit).toHaveBeenCalledWith("webhook-1");
    expect(mocks.constructed).toHaveBeenCalledWith(expect.objectContaining({ limiter: { tokens: CUSTOM_WEBHOOK_LEADS_PER_MINUTE, window: "60 s" }, prefix: "ratelimit:custom-webhook" }));
  });

  it("refuses with the seconds left in the window once the budget is used", async () => {
    mocks.limit.mockResolvedValue({ success: false, reset: Date.now() + 12_400 });
    await expect(checkCustomWebhookRate("webhook-1")).resolves.toEqual({ allowed: false, retryAfterSeconds: 13 });
  });

  it("lets the lead in and logs it when Redis fails, so no lead is lost to the limiter", async () => {
    mocks.limit.mockRejectedValue(new Error("redis down"));
    await expect(checkCustomWebhookRate("webhook-1")).resolves.toEqual({ allowed: true });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("RATE_LIMIT_UNAVAILABLE"));
  });

  it("lets the lead in when Upstash is not configured", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    await expect(checkCustomWebhookRate("webhook-1")).resolves.toEqual({ allowed: true });
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("RATE_LIMIT_NOT_CONFIGURED"));
  });

  it("lets the lead in when the limiter cannot even be built", async () => {
    mocks.constructed.mockImplementation(() => { throw new Error("bad config"); });
    await expect(checkCustomWebhookRate("webhook-1")).resolves.toEqual({ allowed: true });
  });
});

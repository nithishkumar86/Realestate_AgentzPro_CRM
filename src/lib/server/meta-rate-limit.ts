import "server-only";

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { AppError } from "@/lib/server/app-error";
import { getAuthEnv, isUpstashConfigured } from "@/lib/server/env";

/**
 * Per-tenant abuse limits for the Facebook connection endpoints.
 *
 * These endpoints are authenticated, so this is not about anonymous flooding — it is about the blast
 * radius of one tenant's repeated calls. Every one of them fans out into Graph API requests that are
 * charged against THIS APP's rate limits, which are shared by every tenant. A UI retry loop, a stuck
 * browser tab, or one impatient customer clicking "Connect" repeatedly can therefore exhaust the app-level
 * quota and take Facebook lead delivery down for everybody else. Meta's rate-limiting guidance is explicit
 * that app-level limits are app-wide, and Business Use Case throttling escalates the longer it is ignored.
 *
 * Keyed on tenant id rather than IP: the tenant is the authenticated, non-spoofable identity, and it is
 * also the unit that actually consumes the quota. IP keying would let one tenant multiply its budget
 * across devices while punishing unrelated tenants behind a shared corporate NAT.
 */

/** Per tenant, per window. Tuned to the Graph cost of each operation, not to how often a human clicks. */
const META_RATE_LIMITS = {
  // debug_token + token exchange + debug_token + a full /me/accounts walk.
  connection_start: { limit: 10, window: "10 m" },
  // A full /me/accounts walk each time.
  pages_list: { limit: 30, window: "10 m" },
  // Three Graph calls per selected Page, up to 100 Pages.
  pages_connect: { limit: 10, window: "10 m" },
  // One unsubscribe per Page, plus a possible permission revoke. Deliberately the loosest of the four:
  // disconnecting is cheap, and a tenant tearing down twenty-five Pages one at a time must never be told
  // to come back later — being unable to disconnect is a worse failure than being unable to connect.
  disconnect: { limit: 60, window: "10 m" },
} as const satisfies Record<string, { limit: number; window: `${number} ${"s" | "m" | "h"}` }>;

export type MetaRateLimitedOperation = keyof typeof META_RATE_LIMITS;

let cachedRedisClient: Redis | undefined;
const cachedLimiters = new Map<MetaRateLimitedOperation, Ratelimit>();

function getRedisClient(): Redis {
  if (!cachedRedisClient) {
    const environment = getAuthEnv();
    if (!environment.UPSTASH_REDIS_REST_URL || !environment.UPSTASH_REDIS_REST_TOKEN) {
      throw new AppError("Upstash Redis client was requested without Upstash being configured.", {
        status: 503,
        code: "UPSTASH_CONFIGURATION_ERROR",
      });
    }
    cachedRedisClient = new Redis({
      url: environment.UPSTASH_REDIS_REST_URL,
      token: environment.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return cachedRedisClient;
}

function getLimiter(operation: MetaRateLimitedOperation): Ratelimit {
  const cached = cachedLimiters.get(operation);
  if (cached) {
    return cached;
  }

  const { limit, window } = META_RATE_LIMITS[operation];
  // Sliding rather than fixed window: a fixed window lets a tenant spend its whole budget at the very end
  // of one window and again at the start of the next, producing double the intended burst against Graph
  // exactly when it is least affordable.
  const limiter = new Ratelimit({
    redis: getRedisClient(),
    limiter: Ratelimit.slidingWindow(limit, window),
    prefix: `ratelimit:meta:${operation}`,
  });
  cachedLimiters.set(operation, limiter);
  return limiter;
}

/**
 * Throws a typed 429 when this tenant has exhausted its budget for the operation.
 *
 * Fails OPEN, deliberately, and in the opposite direction from getAlreadyConnectedPageIds. That check
 * fails closed because proceeding without it can orphan a subscription — a real, silent data fault. This
 * one only shapes traffic: if Upstash is unreachable, refusing every connect would convert a Redis blip
 * into a total outage of Facebook onboarding, which is a far worse outcome than briefly unmetered calls.
 * The bypass is logged so it is visible rather than assumed.
 *
 * Outside production a missing Upstash configuration skips the check entirely, matching the OTP limiter,
 * so local development does not require a live Redis. getAuthEnv() refuses to start in production without
 * those credentials, so production can never silently run unmetered.
 */
export async function assertMetaRateLimit(operation: MetaRateLimitedOperation, tenantId: string): Promise<void> {
  if (!isUpstashConfigured()) {
    return;
  }

  let result: { success: boolean; reset: number };
  try {
    result = await getLimiter(operation).limit(tenantId);
  } catch (error) {
    console.error(JSON.stringify({
      operation: "meta_rate_limit",
      code: "RATE_LIMIT_UNAVAILABLE",
      metaOperation: operation,
      error: error instanceof Error ? error.message : String(error),
    }));
    return;
  }

  if (result.success) {
    return;
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  throw new AppError("Too many Facebook connection requests. Try again shortly.", {
    status: 429,
    code: "META_RATE_LIMITED",
    retryable: true,
    details: { retryAfterSeconds },
  });
}

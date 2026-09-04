import "server-only";

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { AppError } from "@/lib/server/app-error";
import { getAuthEnv, isUpstashConfigured } from "@/lib/server/env";
import { buildOtpSendEmailKey, buildOtpSendIpKey, buildOtpVerifyKey } from "@/lib/server/auth/otp-identifiers";

/**
 * Upstash Redis-backed OTP rate limiting (login_system_plan.md section
 * 10.2). Every counter here has its own TTL so Redis removes it
 * automatically; none are session/local-storage state.
 *
 * In production, getAuthEnv() throws before this module can be reached
 * without Upstash credentials configured (see src/lib/server/env.ts), so
 * production never runs with these checks silently bypassed. In
 * development, a missing Upstash configuration is treated as "allowed"
 * with `bypassed: true` so login can be exercised without a live Redis
 * instance; callers should log that flag rather than ignore it.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** True only when Upstash is unconfigured outside production and the check was skipped rather than evaluated. */
  bypassed: boolean;
  retryAfterSeconds?: number;
}

const VERIFY_ATTEMPT_WINDOW_SECONDS = 15 * 60;
const VERIFY_ATTEMPT_LIMIT = 5;
const VERIFY_BLOCK_SECONDS = 30 * 60;

let cachedRedisClient: Redis | undefined;
let cachedEmailCooldownLimiter: Ratelimit | undefined;
let cachedEmailHourlyLimiter: Ratelimit | undefined;
let cachedIpHourlyLimiter: Ratelimit | undefined;

/**
 * Every caller of this function must have already checked
 * isUpstashConfigured() and returned a bypassed decision if it was false.
 * This function still fails loudly on its own rather than trusting that
 * discipline silently: a missing credential here is a programming error,
 * not a configuration state a caller should ever be able to reach.
 */
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

function getEmailCooldownLimiter(): Ratelimit {
  if (!cachedEmailCooldownLimiter) {
    cachedEmailCooldownLimiter = new Ratelimit({
      redis: getRedisClient(),
      limiter: Ratelimit.fixedWindow(1, "60 s"),
      prefix: "ratelimit:otp-send-cooldown",
    });
  }
  return cachedEmailCooldownLimiter;
}

function getEmailHourlyLimiter(): Ratelimit {
  if (!cachedEmailHourlyLimiter) {
    cachedEmailHourlyLimiter = new Ratelimit({
      redis: getRedisClient(),
      limiter: Ratelimit.fixedWindow(3, "1 h"),
      prefix: "ratelimit:otp-send-email-hourly",
    });
  }
  return cachedEmailHourlyLimiter;
}

function getIpHourlyLimiter(): Ratelimit {
  if (!cachedIpHourlyLimiter) {
    cachedIpHourlyLimiter = new Ratelimit({
      redis: getRedisClient(),
      limiter: Ratelimit.fixedWindow(10, "1 h"),
      prefix: "ratelimit:otp-send-ip-hourly",
    });
  }
  return cachedIpHourlyLimiter;
}

function bypassedDecision(): RateLimitDecision {
  return { allowed: true, bypassed: true };
}

function toDecision(response: { success: boolean; reset: number }): RateLimitDecision {
  if (response.success) {
    return { allowed: true, bypassed: false };
  }
  const retryAfterSeconds = Math.max(0, Math.ceil((response.reset - Date.now()) / 1000));
  return { allowed: false, bypassed: false, retryAfterSeconds };
}

/** Same normalized email: 1 OTP send per 60 seconds. */
export async function checkOtpSendCooldown(email: string): Promise<RateLimitDecision> {
  if (!isUpstashConfigured()) {
    return bypassedDecision();
  }
  const identifier = buildOtpSendEmailKey(email);
  return toDecision(await getEmailCooldownLimiter().limit(identifier));
}

/** Same normalized email: 3 OTP sends per rolling hour. */
export async function checkOtpSendEmailWindow(email: string): Promise<RateLimitDecision> {
  if (!isUpstashConfigured()) {
    return bypassedDecision();
  }
  const identifier = buildOtpSendEmailKey(email);
  return toDecision(await getEmailHourlyLimiter().limit(identifier));
}

/** Same source IP: 10 OTP sends per rolling hour. */
export async function checkOtpSendIpWindow(sourceIp: string): Promise<RateLimitDecision> {
  if (!isUpstashConfigured()) {
    return bypassedDecision();
  }
  const identifier = buildOtpSendIpKey(sourceIp);
  return toDecision(await getIpHourlyLimiter().limit(identifier));
}

/**
 * True when this email/IP combination is currently within its 30-minute
 * post-threshold block. Call this before attempting OTP verification.
 */
export async function isOtpVerifyBlocked(email: string, sourceIp: string): Promise<RateLimitDecision> {
  if (!isUpstashConfigured()) {
    return bypassedDecision();
  }

  const blockKey = `${buildOtpVerifyKey(email, sourceIp)}:blocked`;
  const redis = getRedisClient();
  const isBlocked = await redis.get<string>(blockKey);

  if (!isBlocked) {
    return { allowed: true, bypassed: false };
  }

  const remainingSeconds = await redis.ttl(blockKey);
  return { allowed: false, bypassed: false, retryAfterSeconds: remainingSeconds > 0 ? remainingSeconds : undefined };
}

/**
 * Records one wrong OTP verification attempt for this email/IP combination.
 * On the 5th attempt within the 15-minute window, applies an explicit
 * 30-minute block — deliberately shorter than a 4-to-5-hour block would be,
 * per login_system_plan.md section 10.2, so a legitimate customer is not
 * denied service for an unreasonably long time because of an attacker.
 */
export async function recordFailedOtpVerification(email: string, sourceIp: string): Promise<RateLimitDecision> {
  if (!isUpstashConfigured()) {
    return bypassedDecision();
  }

  const verifyKey = buildOtpVerifyKey(email, sourceIp);
  const attemptsKey = `${verifyKey}:attempts`;
  const blockKey = `${verifyKey}:blocked`;
  const redis = getRedisClient();

  const attemptCount = await redis.incr(attemptsKey);
  if (attemptCount === 1) {
    await redis.expire(attemptsKey, VERIFY_ATTEMPT_WINDOW_SECONDS);
  }

  if (attemptCount >= VERIFY_ATTEMPT_LIMIT) {
    await redis.set(blockKey, "1", { ex: VERIFY_BLOCK_SECONDS });
    return { allowed: false, bypassed: false, retryAfterSeconds: VERIFY_BLOCK_SECONDS };
  }

  return { allowed: true, bypassed: false };
}

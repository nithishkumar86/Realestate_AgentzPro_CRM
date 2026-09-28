import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";
import { ACTIVITY_HEARTBEAT_MS, INACTIVITY_TIMEOUT_MS } from "@/features/auth/inactivity";
import { getSupabaseEnv } from "@/lib/server/env";

/**
 * Server-side half of the eight-hour idle logout. The browser tracker
 * (src/features/auth/inactivity.ts) logs out an open page on time; this
 * cookie lets src/proxy.ts refuse a session that has been idle too long
 * even when no page was open to do it, e.g. a browser closed overnight.
 *
 * The cookie holds `<timestamp>.<signature>`. The signature is an HMAC over
 * the user id and timestamp, so it cannot be forged, moved to another
 * user, or pushed forward by hand. Only real activity renews it: a new
 * session (OTP verify, invite confirm) or the heartbeat route. Ordinary
 * requests, including background data loads, never do.
 */
export const IDLE_ACTIVITY_COOKIE = "agentz_last_activity";

/** The browser reports activity up to one heartbeat late; allow for that and one missed heartbeat. */
export const SERVER_IDLE_TIMEOUT_MS = INACTIVITY_TIMEOUT_MS + 2 * ACTIVITY_HEARTBEAT_MS;

// Long enough to outlive the idle window, so closing the browser does not drop it: a missing
// cookie means "expired", and that would sign out someone who was active a minute ago.
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const isProduction = process.env.NODE_ENV === "production";

function signingKey(): Buffer {
  // Derived with a fixed label so this key is never the service-role key itself.
  return createHmac("sha256", getSupabaseEnv().SUPABASE_SERVICE_ROLE_KEY).update("agentz-idle-activity-v1").digest();
}

function sign(userId: string, timestamp: number): string {
  return createHmac("sha256", signingKey()).update(`${userId}.${timestamp}`).digest("base64url");
}

export function createActivityValue(userId: string, now = Date.now()): string {
  return `${now}.${sign(userId, now)}`;
}

/** True only for a genuine, unexpired value issued to this user. Anything else counts as idle. */
export function isSessionActive(value: string | undefined, userId: string, now = Date.now()): boolean {
  const match = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(value ?? "");
  if (!match) return false;
  const timestamp = Number(match[1]);
  const expected = Buffer.from(sign(userId, timestamp));
  const actual = Buffer.from(match[2]);
  if (!timingSafeEqual(expected, actual)) return false;
  return timestamp <= now + 60_000 && now - timestamp < SERVER_IDLE_TIMEOUT_MS;
}

/** Call only after the session for `userId` has been established or verified. */
export function setSessionActivity(response: NextResponse, userId: string): void {
  response.cookies.set(IDLE_ACTIVITY_COOKIE, createActivityValue(userId), {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

export function clearSessionActivity(response: NextResponse): void {
  response.cookies.set(IDLE_ACTIVITY_COOKIE, "", {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

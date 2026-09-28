import { beforeEach, describe, expect, it } from "vitest";
import { NextResponse } from "next/server";
import { stubSupabaseEnv } from "@/test/supabase-env";
import { INACTIVITY_TIMEOUT_MS } from "@/features/auth/inactivity";
import {
  clearSessionActivity, createActivityValue, IDLE_ACTIVITY_COOKIE, isSessionActive, SERVER_IDLE_TIMEOUT_MS, setSessionActivity,
} from "./idle-session";

const NOW = Date.UTC(2026, 8, 28, 12);

describe("server-side idle session", () => {
  beforeEach(() => stubSupabaseEnv());

  it("allows eight hours plus the heartbeat allowance, and no more", () => {
    expect(SERVER_IDLE_TIMEOUT_MS - INACTIVITY_TIMEOUT_MS).toBe(10 * 60 * 1000);
    const value = createActivityValue("user-1", NOW);
    expect(isSessionActive(value, "user-1", NOW)).toBe(true);
    expect(isSessionActive(value, "user-1", NOW + SERVER_IDLE_TIMEOUT_MS - 1)).toBe(true);
    expect(isSessionActive(value, "user-1", NOW + SERVER_IDLE_TIMEOUT_MS)).toBe(false);
  });

  it("treats a missing, malformed, forged, or moved value as idle", () => {
    const value = createActivityValue("user-1", NOW);
    const [, signature] = value.split(".");
    expect(isSessionActive(undefined, "user-1", NOW)).toBe(false);
    expect(isSessionActive("", "user-1", NOW)).toBe(false);
    expect(isSessionActive("not-a-value", "user-1", NOW)).toBe(false);
    // A later timestamp with the old signature: pushing the clock forward by hand.
    expect(isSessionActive(`${NOW + 1000}.${signature}`, "user-1", NOW + 1000)).toBe(false);
    expect(isSessionActive(`${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`, "user-1", NOW)).toBe(false);
    expect(isSessionActive(value, "user-2", NOW)).toBe(false);
  });

  it("rejects a value dated in the future beyond clock tolerance", () => {
    expect(isSessionActive(createActivityValue("user-1", NOW + 120_000), "user-1", NOW)).toBe(false);
    expect(isSessionActive(createActivityValue("user-1", NOW + 30_000), "user-1", NOW)).toBe(true);
  });

  it("writes a persistent httpOnly cookie and clears it", () => {
    const set = NextResponse.json({});
    setSessionActivity(set, "user-1");
    const header = set.headers.get("set-cookie") ?? "";
    expect(header).toMatch(new RegExp(`${IDLE_ACTIVITY_COOKIE}=\\d+\\.`));
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=lax/i);
    expect(header).toMatch(/Max-Age=2592000/i);
    const cleared = NextResponse.json({});
    clearSessionActivity(cleared);
    expect(cleared.headers.get("set-cookie")).toMatch(new RegExp(`${IDLE_ACTIVITY_COOKIE}=;.*Max-Age=0`, "i"));
  });
});

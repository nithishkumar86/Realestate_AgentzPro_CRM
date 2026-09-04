import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/env", () => ({
  getAuthEnv: () => ({
    OTP_IDENTIFIER_HMAC_SECRET: "test-only-hmac-secret-value-needs-32-chars",
    SUBSCRIPTION_CRON_SECRET: "test-only-cron-secret-value-needs-32-chars",
  }),
}));

import { buildOtpSendEmailKey, buildOtpSendIpKey, buildOtpVerifyKey } from "@/lib/server/auth/otp-identifiers";

describe("OTP identifier hashing", () => {
  it("normalizes email casing and surrounding whitespace to the same identifier", () => {
    const lower = buildOtpSendEmailKey("owner@example.com");
    const upper = buildOtpSendEmailKey("Owner@Example.com");
    const padded = buildOtpSendEmailKey("  owner@example.com  ");

    expect(upper).toBe(lower);
    expect(padded).toBe(lower);
  });

  it("produces different identifiers for different emails", () => {
    expect(buildOtpSendEmailKey("owner-a@example.com")).not.toBe(buildOtpSendEmailKey("owner-b@example.com"));
  });

  it("never embeds the raw email or IP address in any generated key", () => {
    const email = "owner@example.com";
    const ip = "203.0.113.42";

    const emailKey = buildOtpSendEmailKey(email);
    const ipKey = buildOtpSendIpKey(ip);
    const verifyKey = buildOtpVerifyKey(email, ip);

    for (const key of [emailKey, ipKey, verifyKey]) {
      expect(key).not.toContain(email);
      expect(key).not.toContain(ip);
    }
  });

  it("prefixes each key with its documented namespace", () => {
    expect(buildOtpSendEmailKey("owner@example.com")).toMatch(/^otp:send:email:[0-9a-f]{64}$/);
    expect(buildOtpSendIpKey("203.0.113.42")).toMatch(/^otp:send:ip:[0-9a-f]{64}$/);
    expect(buildOtpVerifyKey("owner@example.com", "203.0.113.42")).toMatch(/^otp:verify:[0-9a-f]{64}$/);
  });

  it("keeps a field separator between email and IP so different pairings cannot collide", () => {
    // Without a separator, "ab" + "c" and "a" + "bc" would concatenate to the
    // same string before hashing.
    const first = buildOtpVerifyKey("ab", "c");
    const second = buildOtpVerifyKey("a", "bc");

    expect(first).not.toBe(second);
  });
});

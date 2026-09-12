import { describe, expect, it } from "vitest";
import { getRequestSourceIp } from "@/lib/server/auth/request-ip";

function makeRequest(headers: Record<string, string>): Request {
  return new Request("https://example.com/api/auth/otp/request", { headers });
}

describe("getRequestSourceIp", () => {
  it("takes the rightmost x-forwarded-for entry, which the trusted proxy appended", () => {
    // The leftmost entries are whatever the client claimed; only the last
    // was observed by infrastructure we control.
    expect(getRequestSourceIp(makeRequest({ "x-forwarded-for": "203.0.113.5, 70.41.3.18, 150.172.238.178" }))).toBe("150.172.238.178");
  });

  it("ignores a client-spoofed leading entry", () => {
    // The attack this defends against: varying the spoofed prefix must not
    // change the key, or every brute-force guess gets a fresh limit bucket.
    const spoofedA = getRequestSourceIp(makeRequest({ "x-forwarded-for": "1.1.1.1, 150.172.238.178" }));
    const spoofedB = getRequestSourceIp(makeRequest({ "x-forwarded-for": "2.2.2.2, 150.172.238.178" }));
    expect(spoofedA).toBe("150.172.238.178");
    expect(spoofedB).toBe("150.172.238.178");
    expect(spoofedA).toBe(spoofedB);
  });

  it("trims whitespace around entries", () => {
    expect(getRequestSourceIp(makeRequest({ "x-forwarded-for": "  70.41.3.18  ,  203.0.113.5  " }))).toBe("203.0.113.5");
  });

  it("prefers x-vercel-forwarded-for, which the platform edge overwrites", () => {
    expect(
      getRequestSourceIp(
        makeRequest({ "x-vercel-forwarded-for": "198.51.100.7", "x-forwarded-for": "1.1.1.1, 150.172.238.178" }),
      ),
    ).toBe("198.51.100.7");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    expect(getRequestSourceIp(makeRequest({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip when the trusted x-forwarded-for entry is not a valid IP", () => {
    expect(getRequestSourceIp(makeRequest({ "x-forwarded-for": "not-an-ip", "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("rejects a junk header rather than minting a distinct rate-limit key from it", () => {
    expect(getRequestSourceIp(makeRequest({ "x-forwarded-for": "'; DROP TABLE leads; --" }))).toBe("unknown");
    expect(getRequestSourceIp(makeRequest({ "x-forwarded-for": "999.999.999.999" }))).toBe("unknown");
  });

  it("falls back to 'unknown' when no header is present", () => {
    expect(getRequestSourceIp(makeRequest({}))).toBe("unknown");
  });

  it("accepts IPv6 addresses", () => {
    expect(getRequestSourceIp(makeRequest({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("strips a port suffix so one client maps to one key", () => {
    expect(getRequestSourceIp(makeRequest({ "x-forwarded-for": "203.0.113.5:54321" }))).toBe("203.0.113.5");
  });

  it("uses the only entry when a single-hop header carries just one address", () => {
    expect(getRequestSourceIp(makeRequest({ "x-forwarded-for": "150.172.238.178" }))).toBe("150.172.238.178");
  });
});

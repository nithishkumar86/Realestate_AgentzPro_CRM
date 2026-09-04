import { describe, expect, it } from "vitest";
import { getRequestSourceIp } from "@/lib/server/auth/request-ip";

function makeRequest(headers: Record<string, string>): Request {
  return new Request("https://example.com/api/auth/otp/request", { headers });
}

describe("getRequestSourceIp", () => {
  it("returns the first IP from a comma-separated x-forwarded-for header", () => {
    expect(getRequestSourceIp(makeRequest({ "x-forwarded-for": "203.0.113.5, 70.41.3.18, 150.172.238.178" }))).toBe("203.0.113.5");
  });

  it("trims whitespace around the first x-forwarded-for entry", () => {
    expect(getRequestSourceIp(makeRequest({ "x-forwarded-for": "  203.0.113.5  , 70.41.3.18" }))).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    expect(getRequestSourceIp(makeRequest({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("falls back to 'unknown' when neither header is present", () => {
    expect(getRequestSourceIp(makeRequest({}))).toBe("unknown");
  });

  it("prefers x-forwarded-for over x-real-ip when both are present", () => {
    expect(getRequestSourceIp(makeRequest({ "x-forwarded-for": "203.0.113.5", "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.5");
  });
});

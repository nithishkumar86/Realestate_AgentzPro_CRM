import { describe, expect, it } from "vitest";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { isAppError } from "@/lib/server/app-error";

function makeRequest(headers: Record<string, string>): Request {
  return new Request("https://crm.example.com/api/auth/otp/verify", { method: "POST", headers });
}

function expectRejected(headers: Record<string, string>): void {
  try {
    assertSameOrigin(makeRequest(headers));
  } catch (error) {
    expect(isAppError(error) && error.code).toBe("CROSS_ORIGIN_REQUEST");
    expect(isAppError(error) && error.status).toBe(403);
    return;
  }
  throw new Error("Expected the cross-origin request to be rejected.");
}

describe("assertSameOrigin", () => {
  it("allows a same-origin request", () => {
    expect(() =>
      assertSameOrigin(makeRequest({ host: "crm.example.com", origin: "https://crm.example.com" })),
    ).not.toThrow();
  });

  it("rejects a cross-origin request", () => {
    expectRejected({ host: "crm.example.com", origin: "https://attacker.example" });
  });

  it("rejects an origin that merely prefixes the real host", () => {
    // Guards against a substring/startsWith style comparison.
    expectRejected({ host: "crm.example.com", origin: "https://crm.example.com.attacker.example" });
  });

  it("rejects a malformed origin rather than letting it through", () => {
    expectRejected({ host: "crm.example.com", origin: "not-a-url" });
  });

  it("falls back to referer when origin is absent", () => {
    expect(() =>
      assertSameOrigin(makeRequest({ host: "crm.example.com", referer: "https://crm.example.com/login" })),
    ).not.toThrow();

    expectRejected({ host: "crm.example.com", referer: "https://attacker.example/page" });
  });

  it("allows a request that carries no origin information at all", () => {
    // Deliberate: a browser cannot suppress Origin on a cross-site POST, so
    // failing this case closed would only break legitimate callers.
    expect(() => assertSameOrigin(makeRequest({ host: "crm.example.com" }))).not.toThrow();
  });

  it("distinguishes ports on the same hostname", () => {
    expectRejected({ host: "localhost:3000", origin: "http://localhost:4000" });
  });
});

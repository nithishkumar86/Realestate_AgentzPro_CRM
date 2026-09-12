// @vitest-environment node
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseMetaSignedRequest } from "@/lib/server/meta-signed-request";
import { getMetaEnv } from "@/lib/server/env";

vi.mock("@/lib/server/env", () => ({ getMetaEnv: vi.fn() }));

const APP_SECRET = "app-secret-value";

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payload: Record<string, unknown>, secret = APP_SECRET): string {
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(encodedPayload).digest();
  return `${base64Url(signature)}.${encodedPayload}`;
}

beforeEach(() => {
  vi.mocked(getMetaEnv).mockReturnValue({ META_APP_SECRET: APP_SECRET } as ReturnType<typeof getMetaEnv>);
});

describe("parseMetaSignedRequest", () => {
  it("accepts a correctly signed payload and returns the app-scoped user id", () => {
    expect(parseMetaSignedRequest(sign({ algorithm: "HMAC-SHA256", issued_at: 1291836800, user_id: "218471" })))
      .toEqual({ algorithm: "HMAC-SHA256", issued_at: 1291836800, user_id: "218471" });
  });

  it.each([
    ["a signature made with the wrong secret", sign({ algorithm: "HMAC-SHA256", user_id: "218471" }, "attacker-secret")],
    ["a tampered payload", `${sign({ algorithm: "HMAC-SHA256", user_id: "218471" }).split(".")[0]}.${base64Url(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "999" }))}`],
    ["a missing signature segment", base64Url(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "218471" }))],
    ["an empty value", ""],
    ["a null value", null],
  ])("rejects %s", (_label, signedRequest) => {
    expect(parseMetaSignedRequest(signedRequest)).toBeNull();
  });

  it("rejects a downgraded algorithm even when the signature verifies", () => {
    // Refusing anything but HMAC-SHA256 stops a forged payload claiming a weaker scheme from being
    // treated as verified.
    expect(parseMetaSignedRequest(sign({ algorithm: "none", user_id: "218471" }))).toBeNull();
  });

  it("rejects a verified payload with no user id, which nothing downstream could act on safely", () => {
    expect(parseMetaSignedRequest(sign({ algorithm: "HMAC-SHA256" }))).toBeNull();
  });
});

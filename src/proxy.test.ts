// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { stubSupabaseEnv } from "@/test/supabase-env";
import { createActivityValue, SERVER_IDLE_TIMEOUT_MS } from "@/lib/server/auth/idle-session";

const auth = vi.hoisted(() => ({ getClaims: vi.fn(), signOut: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth }) }));

const { proxy } = await import("./proxy");

// The it.each table below signs values while tests are being collected, before beforeEach runs.
stubSupabaseEnv();

const SESSION = "sb-project-auth-token";
const signedIn = {
  [`${SESSION}.0`]: "chunk0",
  [`${SESSION}.1`]: "chunk1",
};

function requestTo(path: string, cookies: Record<string, string>): NextRequest {
  const cookie = Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ");
  return new NextRequest(`https://crm.example.com${path}`, { headers: { cookie } });
}

/** Cookies that NextResponse.next({ request }) forwards to the page or route handler. */
function forwardedCookies(response: Response): string {
  return response.headers.get("x-middleware-request-cookie") ?? "";
}

describe("proxy idle enforcement", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubSupabaseEnv();
    auth.getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    auth.signOut.mockResolvedValue({ error: null });
  });

  it("lets an active session through without renewing its idle clock", async () => {
    const response = await proxy(requestTo("/leads", { ...signedIn, agentz_last_activity: createActivityValue("user-1") }));
    expect(response.headers.get("location")).toBeNull();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie") ?? "").not.toContain("agentz_last_activity");
  });

  it.each([
    ["missing", undefined],
    ["expired", createActivityValue("user-1", Date.now() - SERVER_IDLE_TIMEOUT_MS)],
    ["issued to another user", createActivityValue("user-2")],
    ["forged", `${Date.now()}.${"A".repeat(43)}`],
  ])("ends the session on a CRM page when the idle clock is %s", async (_label, activity) => {
    const cookies = activity ? { ...signedIn, agentz_last_activity: activity } : signedIn;
    const response = await proxy(requestTo("/leads", cookies));
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.headers.get("location")).toBe("https://crm.example.com/login");
    const setCookie = response.headers.get("set-cookie") ?? "";
    for (const name of [`${SESSION}\\.0`, `${SESSION}\\.1`, "agentz_last_activity"]) {
      expect(setCookie).toMatch(new RegExp(`${name}=;[^,]*Max-Age=0`, "i"));
    }
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("removes the session from what API routes and pages receive, even when revoking fails", async () => {
    auth.signOut.mockRejectedValue(new Error("network"));
    const response = await proxy(requestTo("/api/leads", signedIn));
    expect(response.headers.get("location")).toBeNull();
    expect(forwardedCookies(response)).not.toContain("sb-");
    expect(response.headers.get("set-cookie")).toMatch(/sb-project-auth-token\.0=;/);
  });

  it("lets the tracker's logout request through after the server has already ended the session", async () => {
    const response = await proxy(requestTo("/api/auth/logout", signedIn));
    expect(response.headers.get("location")).toBeNull();
    expect(forwardedCookies(response)).not.toContain("sb-");
  });

  it("shows the sign-in page instead of bouncing an idle session back into the app", async () => {
    const response = await proxy(requestTo("/login", signedIn));
    expect(response.headers.get("location")).toBeNull();
    expect(auth.signOut).toHaveBeenCalledOnce();
  });

  it.each(["/api/auth/otp/verify", "/api/auth/invite/confirm"])(
    "does not check the old session on %s, which starts a new one",
    async (path) => {
      const response = await proxy(requestTo(path, signedIn));
      expect(auth.signOut).not.toHaveBeenCalled();
      expect(forwardedCookies(response)).toContain(`${SESSION}.0`);
    },
  );

  it("does nothing for a signed-out visitor", async () => {
    auth.getClaims.mockResolvedValue({ data: null });
    await proxy(requestTo("/pricing", {}));
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});

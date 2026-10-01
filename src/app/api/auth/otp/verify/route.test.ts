import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";
import { stubSupabaseEnv } from "@/test/supabase-env";
import { isSessionActive } from "@/lib/server/auth/idle-session";

const mocks = vi.hoisted(() => ({
  verifyOtp: vi.fn(), resolveLoginState: vi.fn(), assertSameOrigin: vi.fn(),
}));
vi.mock("@/lib/server/auth/otp-service", () => ({ verifyOtp: mocks.verifyOtp }));
vi.mock("@/lib/server/auth/login-state", () => ({ resolveLoginState: mocks.resolveLoginState }));
vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: mocks.assertSameOrigin }));
vi.mock("@/lib/server/auth/request-ip", () => ({ getRequestSourceIp: () => "127.0.0.1" }));

beforeEach(() => {
  vi.resetAllMocks();
  stubSupabaseEnv();
  mocks.verifyOtp.mockResolvedValue({ verified: true, userId: "user-1" });
});

const ready = {
  status: "ready", tenantStatus: "active", membershipStatus: "active",
  subscriptionStatus: "active", currentPeriodEndsAt: "2999-01-01T00:00:00Z", trialEndsAt: null,
};
function request() {
  return new Request("https://crm.example.com/api/auth/otp/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "agent@example.com", otp: "123456" }),
  });
}

it.each([
  [ready, "/"],
  [{ status: "needs_onboarding" }, "/onboarding"],
  [{ status: "integrity_error", reason: "PARTIAL_ONBOARDING_STATE" }, "/billing"],
  [{ ...ready, membershipStatus: "blocked" }, "/billing"],
  [{ ...ready, currentPeriodEndsAt: "2000-01-01T00:00:00Z" }, "/billing"],
  [{ status: "no_company" }, "/billing"],
])("routes verified users according to their existing access state: %j", async (state, destination) => {
  mocks.resolveLoginState.mockResolvedValue(state);
  const input = request();
  const response = await POST(input);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ verified: true, redirectTo: destination });
  expect(mocks.assertSameOrigin).toHaveBeenCalledWith(input);
  expect(response.headers.get("cache-control")).toContain("no-store");
});

it("starts the new session's server-side idle clock", async () => {
  mocks.resolveLoginState.mockResolvedValue(ready);
  const response = await POST(request());
  const cookie = response.headers.get("set-cookie") ?? "";
  const value = /agentz_last_activity=([^;]*)/.exec(cookie)?.[1];
  expect(isSessionActive(value, "user-1")).toBe(true);
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/Max-Age=\d+/i);
});

it("resolves the login state from the verified user only", async () => {
  mocks.resolveLoginState.mockResolvedValue(ready);
  await POST(request());
  expect(mocks.resolveLoginState).toHaveBeenCalledWith("user-1");
});

it("does not route an unsuccessful verification into the landing page", async () => {
  mocks.verifyOtp.mockResolvedValue({ verified: false });
  const response = await POST(request());
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ verified: false, blocked: false });
  expect(mocks.resolveLoginState).not.toHaveBeenCalled();
  expect(response.headers.get("set-cookie") ?? "").not.toContain("agentz_last_activity");
});

import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  verifyOtp: vi.fn(), resolveLoginState: vi.fn(), assertSameOrigin: vi.fn(),
  readActiveTenantHint: vi.fn(), listPendingInvitationsForUser: vi.fn(),
}));
vi.mock("@/lib/server/auth/otp-service", () => ({ verifyOtp: mocks.verifyOtp }));
vi.mock("@/lib/server/auth/login-state", () => ({ resolveLoginState: mocks.resolveLoginState }));
vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: mocks.assertSameOrigin }));
vi.mock("@/lib/server/auth/request-ip", () => ({ getRequestSourceIp: () => "127.0.0.1" }));
vi.mock("@/lib/server/auth/active-tenant", () => ({ readActiveTenantHint: mocks.readActiveTenantHint }));
vi.mock("@/lib/server/member-invitation-service", () => ({ listPendingInvitationsForUser: mocks.listPendingInvitationsForUser }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verifyOtp.mockResolvedValue({ verified: true, userId: "user-1" });
  mocks.readActiveTenantHint.mockResolvedValue(null);
  mocks.listPendingInvitationsForUser.mockResolvedValue([]);
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
  [{ status: "needs_workspace_selection" }, "/workspaces"],
])("routes verified users according to their existing access state: %j", async (state, destination) => {
  mocks.resolveLoginState.mockResolvedValue(state);
  const input = request();
  const response = await POST(input);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ verified: true, redirectTo: destination });
  expect(mocks.assertSameOrigin).toHaveBeenCalledWith(input);
  expect(response.headers.get("cache-control")).toContain("no-store");
});

it("passes the active-company hint so a chosen company is re-verified at sign-in", async () => {
  mocks.readActiveTenantHint.mockResolvedValue("10000000-0000-4000-8000-000000000001");
  mocks.resolveLoginState.mockResolvedValue(ready);
  await POST(request());
  expect(mocks.resolveLoginState).toHaveBeenCalledWith("user-1", "10000000-0000-4000-8000-000000000001");
});

it("shows a pending invitation from another company on /workspaces before entering the CRM", async () => {
  mocks.resolveLoginState.mockResolvedValue(ready);
  mocks.listPendingInvitationsForUser.mockResolvedValue([{ invitationId: "i", tenantId: "t", tenantName: "B", role: "employee" }]);
  const response = await POST(request());
  expect(await response.json()).toEqual({ verified: true, redirectTo: "/workspaces" });
});

it("does not route an unsuccessful verification into the landing page", async () => {
  mocks.verifyOtp.mockResolvedValue({ verified: false });
  const response = await POST(request());
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ verified: false, blocked: false });
  expect(mocks.resolveLoginState).not.toHaveBeenCalled();
});

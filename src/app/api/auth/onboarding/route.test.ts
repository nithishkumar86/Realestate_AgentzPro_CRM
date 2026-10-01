import { beforeEach, expect, it, vi } from "vitest";
import { stubSupabaseEnv } from "@/test/supabase-env";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  resolveLoginState: vi.fn(),
  completeOwnerOnboarding: vi.fn(),
  findPending: vi.fn(),
  findWithdrawn: vi.fn(),
}));
vi.mock("@/lib/server/auth/session", () => ({ verifySession: mocks.verifySession }));
vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: vi.fn() }));
vi.mock("@/lib/server/auth/login-state", () => ({ resolveLoginState: mocks.resolveLoginState }));
vi.mock("@/lib/server/auth/onboarding-service", () => ({ completeOwnerOnboarding: mocks.completeOwnerOnboarding }));
vi.mock("@/lib/server/member-invitation-service", () => ({
  findPendingInvitationForUser: mocks.findPending,
  findWithdrawnInvitationForUser: mocks.findWithdrawn,
}));

const request = () =>
  new Request("https://crm.example.com/api/auth/onboarding", { method: "POST", body: JSON.stringify({}) });

beforeEach(() => {
  vi.resetAllMocks();
  stubSupabaseEnv();
  mocks.verifySession.mockResolvedValue({ userId: "user-1" });
  mocks.findPending.mockResolvedValue(null);
  mocks.findWithdrawn.mockResolvedValue(null);
});

it("creates the first account and company for a brand-new person", async () => {
  mocks.resolveLoginState.mockResolvedValue({ status: "needs_onboarding" });
  mocks.completeOwnerOnboarding.mockResolvedValue({ tenantId: "t-1" });
  const response = await POST(request());
  expect(response.status).toBe(201);
  expect(mocks.completeOwnerOnboarding).toHaveBeenCalledTimes(1);
});

it.each(["ready", "no_company"])("refuses someone whose account is already set up (%s) and creates nothing", async (status) => {
  mocks.resolveLoginState.mockResolvedValue({ status });
  const response = await POST(request());
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("ALREADY_ONBOARDED");
  expect(mocks.completeOwnerOnboarding).not.toHaveBeenCalled();
});

it("still sends a new person with a pending invitation to the invitation form", async () => {
  mocks.resolveLoginState.mockResolvedValue({ status: "needs_onboarding" });
  mocks.findPending.mockResolvedValue({ invitationId: "i-1" });
  const response = await POST(request());
  expect(response.status).toBe(409);
  expect(mocks.completeOwnerOnboarding).not.toHaveBeenCalled();
});

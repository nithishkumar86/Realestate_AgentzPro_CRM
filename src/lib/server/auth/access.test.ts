import { describe, expect, it, vi } from "vitest";
import type { LoginState } from "@/lib/server/auth/login-state";

const READY_BASE = {
  status: "ready" as const,
  tenantId: "10000000-0000-0000-0000-000000000001",
  tenantName: "Tenant A",
  fullName: "Owner A",
  membershipRole: "owner",
  membershipStatus: "active",
  tenantStatus: "active",
  currentPeriodEndsAt: null as string | null,
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const future = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const past = (offsetMs: number) => new Date(Date.now() - offsetMs).toISOString();

vi.mock("@/lib/server/auth/session", () => ({
  verifySession: vi.fn(),
}));
vi.mock("@/lib/server/auth/login-state", () => ({
  resolveLoginState: vi.fn(),
}));
vi.mock("@/lib/server/auth/active-tenant", () => ({
  readActiveTenantHint: vi.fn(async () => null),
}));

const { evaluateCrmAccess, requireCrmAccess, requireBillingMember, requireBillingOwner } = await import("@/lib/server/auth/access");
const { verifySession } = await import("@/lib/server/auth/session");
const { resolveLoginState } = await import("@/lib/server/auth/login-state");
const { readActiveTenantHint } = await import("@/lib/server/auth/active-tenant");

describe("evaluateCrmAccess", () => {
  it("grants access for a valid trial before trial_ends_at", () => {
    const state: LoginState = { ...READY_BASE, subscriptionStatus: "trialing", trialEndsAt: future(ONE_HOUR_MS) };
    expect(evaluateCrmAccess(state)).toBe(true);
  });

  it("denies access for the same trial immediately after trial_ends_at", () => {
    const state: LoginState = { ...READY_BASE, subscriptionStatus: "trialing", trialEndsAt: past(1000) };
    expect(evaluateCrmAccess(state)).toBe(false);
  });

  it("grants access for a paid subscription before current_period_ends_at", () => {
    const state: LoginState = { ...READY_BASE, subscriptionStatus: "active", trialEndsAt: null, currentPeriodEndsAt: future(ONE_HOUR_MS) };
    expect(evaluateCrmAccess(state)).toBe(true);
  });

  it("denies access for a paid subscription after current_period_ends_at", () => {
    const state: LoginState = { ...READY_BASE, subscriptionStatus: "active", trialEndsAt: null, currentPeriodEndsAt: past(1000) };
    expect(evaluateCrmAccess(state)).toBe(false);
  });

  it("never grants access when subscription_status is blocked, even with a future trial_ends_at", () => {
    const state: LoginState = { ...READY_BASE, subscriptionStatus: "blocked", trialEndsAt: future(ONE_HOUR_MS) };
    expect(evaluateCrmAccess(state)).toBe(false);
  });

  it("denies access for a suspended tenant even with a valid trial", () => {
    const state: LoginState = { ...READY_BASE, tenantStatus: "suspended", subscriptionStatus: "trialing", trialEndsAt: future(ONE_HOUR_MS) };
    expect(evaluateCrmAccess(state)).toBe(false);
  });

  it("denies access for a blocked membership even with a valid trial", () => {
    const state: LoginState = { ...READY_BASE, membershipStatus: "blocked", subscriptionStatus: "trialing", trialEndsAt: future(ONE_HOUR_MS) };
    expect(evaluateCrmAccess(state)).toBe(false);
  });

  it("denies access when the login state is needs_onboarding", () => {
    expect(evaluateCrmAccess({ status: "needs_onboarding" })).toBe(false);
  });

  it("denies access when no company is chosen", () => {
    expect(evaluateCrmAccess({ status: "needs_workspace_selection" })).toBe(false);
  });

  it("denies access when the login state is integrity_error", () => {
    expect(evaluateCrmAccess({ status: "integrity_error", reason: "TENANT_MISSING" })).toBe(false);
  });
});

describe("requireCrmAccess", () => {
  it("throws UNAUTHENTICATED (401) when there is no session", async () => {
    vi.mocked(verifySession).mockResolvedValue(null);

    await expect(requireCrmAccess()).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("throws ONBOARDING_REQUIRED (403) when onboarding has not been completed", async () => {
    vi.mocked(verifySession).mockResolvedValue({ userId: "user-1" });
    vi.mocked(resolveLoginState).mockResolvedValue({ status: "needs_onboarding" });

    await expect(requireCrmAccess()).rejects.toMatchObject({ status: 403, code: "ONBOARDING_REQUIRED" });
  });

  it("throws WORKSPACE_SELECTION_REQUIRED (403) when no company is chosen", async () => {
    vi.mocked(verifySession).mockResolvedValue({ userId: "user-1" });
    vi.mocked(resolveLoginState).mockResolvedValue({ status: "needs_workspace_selection" });

    await expect(requireCrmAccess()).rejects.toMatchObject({ status: 403, code: "WORKSPACE_SELECTION_REQUIRED" });
  });

  it("resolves access for the active-company hint, which login-state re-verifies", async () => {
    vi.mocked(verifySession).mockResolvedValue({ userId: "user-1" });
    vi.mocked(readActiveTenantHint).mockResolvedValueOnce(READY_BASE.tenantId);
    vi.mocked(resolveLoginState).mockResolvedValue({ ...READY_BASE, subscriptionStatus: "trialing", trialEndsAt: future(ONE_HOUR_MS) });

    await requireCrmAccess();

    expect(resolveLoginState).toHaveBeenCalledWith("user-1", READY_BASE.tenantId);
  });

  it("throws ACCOUNT_INTEGRITY_ERROR (403) on a partial/contradictory record set", async () => {
    vi.mocked(verifySession).mockResolvedValue({ userId: "user-1" });
    vi.mocked(resolveLoginState).mockResolvedValue({ status: "integrity_error", reason: "TENANT_MISSING" });

    await expect(requireCrmAccess()).rejects.toMatchObject({ status: 403, code: "ACCOUNT_INTEGRITY_ERROR" });
  });

  it("throws CRM_ACCESS_DENIED (403) for a ready state whose subscription is expired", async () => {
    vi.mocked(verifySession).mockResolvedValue({ userId: "user-1" });
    vi.mocked(resolveLoginState).mockResolvedValue({ ...READY_BASE, subscriptionStatus: "blocked", trialEndsAt: null });

    await expect(requireCrmAccess()).rejects.toMatchObject({ status: 403, code: "CRM_ACCESS_DENIED" });
  });

  it("returns the userId and tenantId for a valid, active session", async () => {
    vi.mocked(verifySession).mockResolvedValue({ userId: "user-1" });
    vi.mocked(resolveLoginState).mockResolvedValue({ ...READY_BASE, subscriptionStatus: "trialing", trialEndsAt: future(ONE_HOUR_MS) });

    await expect(requireCrmAccess()).resolves.toEqual({
      userId: "user-1",
      tenantId: READY_BASE.tenantId,
      tenantName: READY_BASE.tenantName,
      fullName: READY_BASE.fullName,
      membershipRole: READY_BASE.membershipRole,
    });
  });
});

describe("billing access", () => {
  it("lets the owner of a BLOCKED company reach billing, because that is who needs to pay", async () => {
    vi.mocked(verifySession).mockResolvedValue({ userId: "owner-a" });
    vi.mocked(resolveLoginState).mockResolvedValue({ ...READY_BASE, subscriptionStatus: "blocked", trialEndsAt: past(ONE_HOUR_MS) });

    await expect(requireBillingOwner()).resolves.toMatchObject({
      tenantId: READY_BASE.tenantId,
      membershipRole: "owner",
      hasCrmAccess: false,
    });
  });

  it("refuses an employee from changing billing but still lets them read status", async () => {
    vi.mocked(verifySession).mockResolvedValue({ userId: "employee-a" });
    vi.mocked(resolveLoginState).mockResolvedValue({
      ...READY_BASE,
      membershipRole: "employee",
      subscriptionStatus: "trialing",
      trialEndsAt: future(ONE_HOUR_MS),
    });

    await expect(requireBillingOwner()).rejects.toMatchObject({ status: 403, code: "BILLING_OWNER_REQUIRED" });
    await expect(requireBillingMember()).resolves.toMatchObject({ membershipRole: "employee", hasCrmAccess: true });
  });

  it("resolves the tenant only from the verified active-tenant hint", async () => {
    vi.mocked(verifySession).mockResolvedValue({ userId: "owner-a" });
    vi.mocked(readActiveTenantHint).mockResolvedValueOnce("10000000-0000-0000-0000-000000000002");
    vi.mocked(resolveLoginState).mockResolvedValue({ ...READY_BASE, subscriptionStatus: "trialing", trialEndsAt: future(ONE_HOUR_MS) });

    await requireBillingOwner();
    expect(resolveLoginState).toHaveBeenLastCalledWith("owner-a", "10000000-0000-0000-0000-000000000002");
  });

  it("refuses when no company is chosen or the session is missing", async () => {
    vi.mocked(verifySession).mockResolvedValue(null);
    await expect(requireBillingMember()).rejects.toMatchObject({ status: 401 });

    vi.mocked(verifySession).mockResolvedValue({ userId: "multi" });
    vi.mocked(resolveLoginState).mockResolvedValue({ status: "needs_workspace_selection" });
    await expect(requireBillingMember()).rejects.toMatchObject({ code: "WORKSPACE_SELECTION_REQUIRED" });
  });

  it("refuses a suspended tenant", async () => {
    vi.mocked(verifySession).mockResolvedValue({ userId: "owner-a" });
    vi.mocked(resolveLoginState).mockResolvedValue({
      ...READY_BASE,
      tenantStatus: "suspended",
      subscriptionStatus: "blocked",
      trialEndsAt: null,
    });
    await expect(requireBillingOwner()).rejects.toMatchObject({ code: "BILLING_NOT_ALLOWED" });
  });
});

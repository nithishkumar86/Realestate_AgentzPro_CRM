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

const { evaluateCrmAccess, requireCrmAccess } = await import("@/lib/server/auth/access");
const { verifySession } = await import("@/lib/server/auth/session");
const { resolveLoginState } = await import("@/lib/server/auth/login-state");

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
    });
  });
});

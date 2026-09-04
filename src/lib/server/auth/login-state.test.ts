import { describe, expect, it, vi } from "vitest";

type TableResponse = { data: unknown; error: unknown };

let tableResponses: Record<string, TableResponse> = {};

function createFakeSupabaseAdminClient() {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => tableResponses[table] ?? { data: null, error: null },
              };
            },
          };
        },
      };
    },
  };
}

vi.mock("@/lib/server/supabase-admin", () => ({
  getSupabaseAdminClient: () => createFakeSupabaseAdminClient(),
}));

const { resolveLoginState } = await import("@/lib/server/auth/login-state");

const USER_ID = "00000000-0000-0000-0000-000000000001";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";

describe("resolveLoginState", () => {
  it("returns needs_onboarding when neither a membership nor a profile row exists", async () => {
    tableResponses = {
      tenant_memberships: { data: null, error: null },
      profiles: { data: null, error: null },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "needs_onboarding" });
  });

  it("returns ready with the full ownership chain when all four rows are consistent", async () => {
    tableResponses = {
      tenant_memberships: { data: { tenant_id: TENANT_ID, membership_role: "owner", membership_status: "active" }, error: null },
      profiles: { data: { user_id: USER_ID, full_name: "Owner A" }, error: null },
      tenants: { data: { tenant_name: "Tenant A", tenant_status: "active" }, error: null },
      tenants_subscriptions: {
        data: { subscription_status: "trialing", trial_ends_at: "2026-09-17T00:00:00.000Z", current_period_ends_at: null },
        error: null,
      },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toStrictEqual({
      status: "ready",
      tenantId: TENANT_ID,
      tenantName: "Tenant A",
      fullName: "Owner A",
      membershipRole: "owner",
      membershipStatus: "active",
      tenantStatus: "active",
      subscriptionStatus: "trialing",
      trialEndsAt: "2026-09-17T00:00:00.000Z",
      currentPeriodEndsAt: null,
    });
  });

  it("returns integrity_error, and never fabricates a tenant, when a membership exists without a profile", async () => {
    tableResponses = {
      tenant_memberships: { data: { tenant_id: TENANT_ID, membership_role: "owner", membership_status: "active" }, error: null },
      profiles: { data: null, error: null },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "PARTIAL_ONBOARDING_STATE" });
  });

  it("returns integrity_error when a profile exists without a membership", async () => {
    tableResponses = {
      tenant_memberships: { data: null, error: null },
      profiles: { data: { user_id: USER_ID }, error: null },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "PARTIAL_ONBOARDING_STATE" });
  });

  it("returns integrity_error when the membership's tenant row is missing", async () => {
    tableResponses = {
      tenant_memberships: { data: { tenant_id: TENANT_ID, membership_role: "owner", membership_status: "active" }, error: null },
      profiles: { data: { user_id: USER_ID }, error: null },
      tenants: { data: null, error: null },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "TENANT_MISSING" });
  });

  it("returns integrity_error when the tenant's subscription row is missing", async () => {
    tableResponses = {
      tenant_memberships: { data: { tenant_id: TENANT_ID, membership_role: "owner", membership_status: "active" }, error: null },
      profiles: { data: { user_id: USER_ID }, error: null },
      tenants: { data: { tenant_status: "active" }, error: null },
      tenants_subscriptions: { data: null, error: null },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "SUBSCRIPTION_MISSING" });
  });

  it("returns integrity_error when the membership query itself fails", async () => {
    tableResponses = {
      tenant_memberships: { data: null, error: { message: "connection reset" } },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "MEMBERSHIP_QUERY_FAILED" });
  });
});

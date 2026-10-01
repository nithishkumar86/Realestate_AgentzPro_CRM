import { describe, expect, it, vi } from "vitest";

type TableResponse = { data: unknown; error: unknown };

let tableResponses: Record<string, TableResponse> = {};
let tenantResponses: Record<string, TableResponse> = {};

// Every table is read via maybeSingle(): one login belongs to at most one company.
function createFakeSupabaseAdminClient() {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq(column: string, value: string) {
              const response = () =>
                column === "tenant_id" && tenantResponses[`${table}:${value}`]
                  ? tenantResponses[`${table}:${value}`]
                  : tableResponses[table] ?? { data: null, error: null };
              return {
                maybeSingle: async () => response(),
                then: (resolve: (value: TableResponse) => unknown, reject: (reason: unknown) => unknown) =>
                  Promise.resolve(response()).then(resolve, reject),
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

const OWNER_MEMBERSHIP = { tenant_id: TENANT_ID, membership_role: "owner", membership_status: "active" };
const TRIAL = { subscription_status: "trialing", trial_ends_at: "2026-09-17T00:00:00.000Z", current_period_ends_at: null };

describe("resolveLoginState", () => {
  it("returns needs_onboarding when neither a membership nor a profile row exists", async () => {
    tenantResponses = {};
    tableResponses = {
      tenant_memberships: { data: null, error: null },
      profiles: { data: null, error: null },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "needs_onboarding" });
  });

  it("returns ready with the full ownership chain for a single, consistent membership", async () => {
    tenantResponses = {};
    tableResponses = {
      tenant_memberships: { data: OWNER_MEMBERSHIP, error: null },
      profiles: { data: { user_id: USER_ID, full_name: "Owner A" }, error: null },
      tenants: { data: { tenant_name: "Tenant A", tenant_status: "active" }, error: null },
      tenants_subscriptions: { data: TRIAL, error: null },
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

  it("returns no_company for a person with a profile but no company (the owner removed them)", async () => {
    tenantResponses = {};
    tableResponses = {
      tenant_memberships: { data: null, error: null },
      profiles: { data: { user_id: USER_ID }, error: null },
    };

    await expect(resolveLoginState(USER_ID)).resolves.toEqual({ status: "no_company" });
  });

  it("returns integrity_error, and never fabricates a tenant, when a membership exists without a profile", async () => {
    tenantResponses = {};
    tableResponses = {
      tenant_memberships: { data: OWNER_MEMBERSHIP, error: null },
      profiles: { data: null, error: null },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "PARTIAL_ONBOARDING_STATE" });
  });

  it("returns integrity_error when the membership's tenant row is missing", async () => {
    tenantResponses = {};
    tableResponses = {
      tenant_memberships: { data: OWNER_MEMBERSHIP, error: null },
      profiles: { data: { user_id: USER_ID }, error: null },
      tenants: { data: null, error: null },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "TENANT_MISSING" });
  });

  it("returns integrity_error when the tenant's subscription row is missing", async () => {
    tenantResponses = {};
    tableResponses = {
      tenant_memberships: { data: OWNER_MEMBERSHIP, error: null },
      profiles: { data: { user_id: USER_ID }, error: null },
      tenants: { data: { tenant_status: "active" }, error: null },
      tenants_subscriptions: { data: null, error: null },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "SUBSCRIPTION_MISSING" });
  });

  it("returns integrity_error when the membership query itself fails", async () => {
    tenantResponses = {};
    tableResponses = {
      tenant_memberships: { data: null, error: { message: "connection reset" } },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "MEMBERSHIP_QUERY_FAILED" });
  });
});

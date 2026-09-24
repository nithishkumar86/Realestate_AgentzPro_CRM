import { describe, expect, it, vi } from "vitest";

type TableResponse = { data: unknown; error: unknown };

let tableResponses: Record<string, TableResponse> = {};
let tenantResponses: Record<string, TableResponse> = {};

// tenant_memberships is read as a list (awaited directly); every other table via maybeSingle().
// tenants / tenants_subscriptions answer per tenant_id so the chosen company is observable.
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
const OTHER_TENANT_ID = "10000000-0000-0000-0000-000000000002";

const OWNER_MEMBERSHIP = { tenant_id: TENANT_ID, membership_role: "owner", membership_status: "active" };
const EMPLOYEE_MEMBERSHIP = { tenant_id: OTHER_TENANT_ID, membership_role: "employee", membership_status: "active" };
const TRIAL = { subscription_status: "trialing", trial_ends_at: "2026-09-17T00:00:00.000Z", current_period_ends_at: null };

function twoCompanies() {
  tableResponses = {
    tenant_memberships: { data: [OWNER_MEMBERSHIP, EMPLOYEE_MEMBERSHIP], error: null },
    profiles: { data: { user_id: USER_ID, full_name: "Ravi" }, error: null },
  };
  tenantResponses = {
    [`tenants:${TENANT_ID}`]: { data: { tenant_name: "Agency A", tenant_status: "active" }, error: null },
    [`tenants:${OTHER_TENANT_ID}`]: { data: { tenant_name: "Agency B", tenant_status: "active" }, error: null },
    [`tenants_subscriptions:${TENANT_ID}`]: { data: TRIAL, error: null },
    [`tenants_subscriptions:${OTHER_TENANT_ID}`]: { data: TRIAL, error: null },
  };
}

describe("resolveLoginState", () => {
  it("returns needs_onboarding when neither a membership nor a profile row exists", async () => {
    tenantResponses = {};
    tableResponses = {
      tenant_memberships: { data: [], error: null },
      profiles: { data: null, error: null },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "needs_onboarding" });
  });

  it("returns ready with the full ownership chain for a single, consistent membership", async () => {
    tenantResponses = {};
    tableResponses = {
      tenant_memberships: { data: [OWNER_MEMBERSHIP], error: null },
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

  it("asks the person to choose when they belong to several companies and none is chosen", async () => {
    twoCompanies();
    await expect(resolveLoginState(USER_ID)).resolves.toEqual({ status: "needs_workspace_selection" });
  });

  it("opens the chosen company, with that company's own role, when the hint matches a membership", async () => {
    twoCompanies();

    const state = await resolveLoginState(USER_ID, OTHER_TENANT_ID);

    expect(state).toMatchObject({ status: "ready", tenantId: OTHER_TENANT_ID, tenantName: "Agency B", membershipRole: "employee" });
  });

  it("never opens a company from a hint the user is not a member of", async () => {
    twoCompanies();
    const foreignTenant = "99999999-0000-0000-0000-000000000009";
    tenantResponses[`tenants:${foreignTenant}`] = { data: { tenant_name: "Someone else", tenant_status: "active" }, error: null };

    await expect(resolveLoginState(USER_ID, foreignTenant)).resolves.toEqual({ status: "needs_workspace_selection" });
  });

  it("ignores a stale hint and falls back to the only remaining membership", async () => {
    tenantResponses = {};
    tableResponses = {
      tenant_memberships: { data: [OWNER_MEMBERSHIP], error: null },
      profiles: { data: { user_id: USER_ID, full_name: "Owner A" }, error: null },
      tenants: { data: { tenant_name: "Tenant A", tenant_status: "active" }, error: null },
      tenants_subscriptions: { data: TRIAL, error: null },
    };

    await expect(resolveLoginState(USER_ID, OTHER_TENANT_ID)).resolves.toMatchObject({ status: "ready", tenantId: TENANT_ID });
  });

  it("sends a person with a profile but no company (e.g. removed from their only one) to choose", async () => {
    tenantResponses = {};
    tableResponses = {
      tenant_memberships: { data: [], error: null },
      profiles: { data: { user_id: USER_ID }, error: null },
    };

    await expect(resolveLoginState(USER_ID)).resolves.toEqual({ status: "needs_workspace_selection" });
  });

  it("returns integrity_error, and never fabricates a tenant, when a membership exists without a profile", async () => {
    tenantResponses = {};
    tableResponses = {
      tenant_memberships: { data: [OWNER_MEMBERSHIP], error: null },
      profiles: { data: null, error: null },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "PARTIAL_ONBOARDING_STATE" });
  });

  it("returns integrity_error when the membership's tenant row is missing", async () => {
    tenantResponses = {};
    tableResponses = {
      tenant_memberships: { data: [OWNER_MEMBERSHIP], error: null },
      profiles: { data: { user_id: USER_ID }, error: null },
      tenants: { data: null, error: null },
    };

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "TENANT_MISSING" });
  });

  it("returns integrity_error when the tenant's subscription row is missing", async () => {
    tenantResponses = {};
    tableResponses = {
      tenant_memberships: { data: [OWNER_MEMBERSHIP], error: null },
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

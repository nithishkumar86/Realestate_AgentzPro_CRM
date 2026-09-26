import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingAccess } from "@/lib/server/auth/access";

type Operation = "select" | "insert" | "update";
interface QueryCall {
  table: string;
  operation: Operation;
  values?: unknown;
  filters: Record<string, unknown>;
}

const calls: QueryCall[] = [];
// Answers every query from the table, operation and filters; each test sets the answers it needs.
let answer: (call: QueryCall) => { data?: unknown; error?: unknown } = () => ({ data: null, error: null });
const rpc = vi.fn();

function query(table: string, operation: Operation, values?: unknown) {
  const call: QueryCall = { table, operation, values, filters: {} };
  const resolve = () => {
    calls.push(call);
    const result = answer(call);
    return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
  };
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      call.filters[column] = value;
      return chain;
    },
    in: (column: string, value: unknown) => {
      call.filters[column] = value;
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    maybeSingle: resolve,
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => resolve().then(onFulfilled, onRejected),
  };
  return chain;
}

vi.mock("@/lib/server/supabase-admin", () => ({
  getSupabaseAdminClient: () => ({
    rpc,
    from: (table: string) => ({
      select: () => query(table, "select"),
      insert: (values: unknown) => query(table, "insert", values),
      update: (values: unknown) => query(table, "update", values),
    }),
  }),
}));

const createSubscription = vi.fn();
const cancelSubscription = vi.fn();
const fetchSubscription = vi.fn();

vi.mock("@/lib/server/razorpay-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/razorpay-client")>()),
  getRazorpayClient: () => ({ createSubscription, cancelSubscription, fetchSubscription }),
}));

vi.mock("@/lib/server/env", () => ({
  getRazorpayEnv: () => ({ RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w" }),
}));

const { startCheckout, cancelAtPeriodEnd } = await import("@/lib/server/billing-service");

const OWNER: BillingAccess = {
  userId: "owner-1",
  tenantId: "10000000-0000-0000-0000-000000000001",
  tenantName: "Sharma Realty",
  membershipRole: "owner",
  subscriptionStatus: "trialing",
  trialEndsAt: new Date(Date.now() + 86_400_000).toISOString(),
  currentPeriodEndsAt: null,
  hasCrmAccess: true,
};

const PLAN = {
  billing_plan_id: "plan-row-1",
  plan_code: "pro_monthly",
  plan_name: "Pro Monthly",
  tier: "pro",
  billing_period: "monthly",
  razorpay_plan_id: "plan_PRO",
  price_per_seat_paise: 49900,
  total_count: 120,
};

function usage(activeMembers: number) {
  return { data: [{ is_paid: false, paid_seats: null, active_members: activeMembers, pending_invitations: 0 }], error: null };
}

describe("startCheckout", () => {
  let existingSubscriptions: unknown[];

  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    existingSubscriptions = [];
    rpc.mockResolvedValue(usage(2));
    createSubscription.mockResolvedValue({ id: "sub_NEW", status: "created", quantity: 3, current_start: null, current_end: null, notes: {} });
    answer = (call) => {
      if (call.table === "billing_plans") return { data: PLAN };
      if (call.table === "billing_subscriptions" && call.operation === "select") return { data: existingSubscriptions };
      return { data: null };
    };
  });

  it("creates the subscription for the ACTIVE tenant and records it before returning the id", async () => {
    const session = await startCheckout(OWNER, { planCode: "pro_monthly", seats: 3 });

    expect(createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan_PRO",
        quantity: 3,
        totalCount: 120,
        notes: { tenant_id: OWNER.tenantId, billing_plan_code: "pro_monthly" },
      }),
    );
    const insert = calls.find((call) => call.table === "billing_subscriptions" && call.operation === "insert");
    expect(insert?.values).toEqual({
      tenant_id: OWNER.tenantId,
      billing_plan_id: "plan-row-1",
      razorpay_subscription_id: "sub_NEW",
      seat_quantity: 3,
      razorpay_status: "created",
      created_by_user_id: "owner-1",
    });
    expect(session).toEqual({
      subscriptionId: "sub_NEW",
      keyId: "rzp_test_key",
      planName: "Pro Monthly",
      seats: 3,
      amountPaise: 149700,
      companyName: "Sharma Realty",
    });
  });

  it("refuses an employee before touching Razorpay", async () => {
    await expect(startCheckout({ ...OWNER, membershipRole: "employee" }, { planCode: "pro_monthly", seats: 3 })).rejects.toMatchObject({
      status: 403,
      code: "BILLING_OWNER_REQUIRED",
    });
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("refuses fewer seats than people already in the company", async () => {
    rpc.mockResolvedValue(usage(4));
    await expect(startCheckout(OWNER, { planCode: "pro_monthly", seats: 3 })).rejects.toMatchObject({
      code: "SEATS_BELOW_MEMBERS",
      details: { minimumSeats: 4 },
    });
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("refuses a second subscription while one is live (no double billing)", async () => {
    existingSubscriptions = [{ billing_subscription_id: "bs-1", razorpay_subscription_id: "sub_OLD", razorpay_status: "active" }];
    await expect(startCheckout(OWNER, { planCode: "pro_monthly", seats: 3 })).rejects.toMatchObject({ code: "SUBSCRIPTION_ALREADY_EXISTS" });
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("cancels an abandoned checkout before starting a new one", async () => {
    existingSubscriptions = [{ billing_subscription_id: "bs-old", razorpay_subscription_id: "sub_OLD", razorpay_status: "created" }];
    cancelSubscription.mockResolvedValueOnce({ id: "sub_OLD", status: "cancelled" });

    await startCheckout(OWNER, { planCode: "pro_monthly", seats: 3 });

    expect(cancelSubscription).toHaveBeenCalledWith("sub_OLD", { atCycleEnd: false });
    expect(calls).toContainEqual(
      expect.objectContaining({ table: "billing_subscriptions", operation: "update", values: { razorpay_status: "cancelled" } }),
    );
    expect(createSubscription).toHaveBeenCalled();
  });

  it("does not open a second checkout when the abandoned one cannot be retired", async () => {
    existingSubscriptions = [{ billing_subscription_id: "bs-old", razorpay_subscription_id: "sub_OLD", razorpay_status: "created" }];
    cancelSubscription.mockRejectedValueOnce(new Error("cancel refused"));
    fetchSubscription.mockResolvedValueOnce({ id: "sub_OLD", status: "active" });

    await expect(startCheckout(OWNER, { planCode: "pro_monthly", seats: 3 })).rejects.toMatchObject({ code: "PREVIOUS_CHECKOUT_PENDING" });
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("cancels the new Razorpay subscription when it cannot be recorded, so it can never be paid unmapped", async () => {
    answer = (call) => {
      if (call.table === "billing_plans") return { data: PLAN };
      if (call.table === "billing_subscriptions" && call.operation === "select") return { data: [] };
      if (call.table === "billing_subscriptions" && call.operation === "insert") return { error: { code: "XX000" } };
      return { data: null };
    };
    cancelSubscription.mockResolvedValue({ id: "sub_NEW", status: "cancelled" });

    await expect(startCheckout(OWNER, { planCode: "pro_monthly", seats: 3 })).rejects.toMatchObject({ code: "CHECKOUT_FAILED" });
    expect(cancelSubscription).toHaveBeenCalledWith("sub_NEW", { atCycleEnd: false });
  });

  it("rejects an unknown or retired plan", async () => {
    answer = (call) => (call.table === "billing_plans" ? { data: null } : { data: [] });
    await expect(startCheckout(OWNER, { planCode: "pro_weekly", seats: 1 })).rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
  });

  it("rejects malformed input", async () => {
    await expect(startCheckout(OWNER, { planCode: "pro_monthly", seats: 0 })).rejects.toMatchObject({ code: "INVALID_CHECKOUT_INPUT" });
    await expect(startCheckout(OWNER, { planCode: "Pro Monthly!", seats: 2 })).rejects.toMatchObject({ code: "INVALID_CHECKOUT_INPUT" });
  });
});

describe("cancelAtPeriodEnd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
  });

  function withCurrent(subscription: Record<string, unknown> | null) {
    answer = (call) => {
      if (call.table === "tenants_subscriptions") return { data: { active_billing_subscription_id: subscription ? "bs-1" : null } };
      if (call.table === "billing_subscriptions" && call.operation === "select") return { data: subscription };
      return { data: null };
    };
  }

  it("cancels an active subscription at cycle end and keeps the paid period", async () => {
    withCurrent({
      billing_subscription_id: "bs-1",
      razorpay_subscription_id: "sub_ACTIVE",
      razorpay_status: "active",
      seat_quantity: 3,
      current_period_end: "2026-10-26T00:00:00.000Z",
      cancel_at_period_end: false,
      billing_plans: null,
    });
    cancelSubscription.mockResolvedValue({ id: "sub_ACTIVE", status: "active" });

    await expect(cancelAtPeriodEnd({ ...OWNER, subscriptionStatus: "active" })).resolves.toEqual({ periodEndsAt: "2026-10-26T00:00:00.000Z" });
    expect(cancelSubscription).toHaveBeenCalledWith("sub_ACTIVE", { atCycleEnd: true });
    expect(calls).toContainEqual(
      expect.objectContaining({
        table: "billing_subscriptions",
        operation: "update",
        values: { razorpay_status: "active", cancel_at_period_end: true },
        filters: { billing_subscription_id: "bs-1", tenant_id: OWNER.tenantId },
      }),
    );
  });

  it("refuses when there is no active subscription (Razorpay rejects cycle-end cancel before activation)", async () => {
    withCurrent(null);
    await expect(cancelAtPeriodEnd(OWNER)).rejects.toMatchObject({ code: "NO_ACTIVE_SUBSCRIPTION" });
    expect(cancelSubscription).not.toHaveBeenCalled();
  });

  it("refuses an employee", async () => {
    await expect(cancelAtPeriodEnd({ ...OWNER, membershipRole: "employee" })).rejects.toMatchObject({ code: "BILLING_OWNER_REQUIRED" });
  });
});

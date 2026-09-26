import "server-only";

import { z } from "zod";
import { AppError } from "@/lib/server/app-error";
import type { BillingAccess } from "@/lib/server/auth/access";
import { getRazorpayEnv } from "@/lib/server/env";
import { getRazorpayClient, type RazorpaySubscriptionStatus } from "@/lib/server/razorpay-client";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * Owner-facing billing actions (supabase/migrations/20260926120000_billing_razorpay.sql).
 *
 * The one rule everything here protects: a Razorpay subscription is created ONLY by this server, for
 * the caller's verified active tenant, and its sub_… id is stored against that tenant BEFORE the
 * browser can open Razorpay Checkout. The payment webhook finds the tenant through that row. Access
 * itself is granted only by the webhook — nothing in this file unlocks the CRM.
 */

/** Subscriptions that are, or are about to be, charging this tenant. A second one would double-bill. */
const LIVE_STATUSES: readonly RazorpaySubscriptionStatus[] = ["authenticated", "active", "pending"];

/** How long the customer has to finish the first payment before Razorpay expires the subscription. */
const CHECKOUT_WINDOW_SECONDS = 30 * 60;

export const MAX_SEATS = 500;

const checkoutInputSchema = z.object({
  planCode: z.string().trim().regex(/^[a-z0-9_]{2,40}$/),
  seats: z.number().int().min(1).max(MAX_SEATS),
});

export interface CheckoutSession {
  subscriptionId: string;
  keyId: string;
  planName: string;
  seats: number;
  amountPaise: number;
  companyName: string;
}

interface PlanRow {
  billing_plan_id: string;
  plan_code: string;
  plan_name: string;
  tier: string;
  billing_period: "monthly" | "yearly";
  razorpay_plan_id: string;
  price_per_seat_paise: number;
  total_count: number;
}

interface SeatUsageRow {
  is_paid: boolean;
  paid_seats: number | null;
  active_members: number;
  pending_invitations: number;
}

function logBillingEvent(reason: string, extra: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ operation: "billing", reason, ...extra }));
}

async function loadSeatUsage(tenantId: string): Promise<SeatUsageRow> {
  const { data, error } = await getSupabaseAdminClient().rpc("tenant_seat_usage", { p_tenant_id: tenantId });
  const row = (Array.isArray(data) ? data[0] : data) as SeatUsageRow | null | undefined;
  if (error || !row) {
    throw new AppError("Billing details could not be loaded.", { status: 500, code: "BILLING_LOAD_FAILED", retryable: true });
  }
  return row;
}

/**
 * Starts a checkout for the owner's active tenant. Steps, in order:
 *   1. validate plan + seats (seats can never be fewer than people already in the company)
 *   2. refuse if a live subscription already exists (no double billing)
 *   3. cancel this tenant's abandoned `created` subscriptions, so a late payment on an old checkout
 *      cannot start a second subscription
 *   4. create the Razorpay subscription with notes.tenant_id
 *   5. record sub_… -> tenant in billing_subscriptions, and only then hand the id to the browser
 */
export async function startCheckout(access: BillingAccess, rawInput: unknown): Promise<CheckoutSession> {
  requireOwner(access);

  const parsed = checkoutInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError("Choose a plan and a valid number of seats.", { status: 400, code: "INVALID_CHECKOUT_INPUT" });
  }
  const { planCode, seats } = parsed.data;
  const db = getSupabaseAdminClient();

  const { data: plan, error: planError } = await db
    .from("billing_plans")
    .select("billing_plan_id,plan_code,plan_name,tier,billing_period,razorpay_plan_id,price_per_seat_paise,total_count")
    .eq("plan_code", planCode)
    .eq("is_active", true)
    .maybeSingle<PlanRow>();

  if (planError) {
    throw new AppError("Plans could not be loaded.", { status: 500, code: "BILLING_LOAD_FAILED", retryable: true });
  }
  if (!plan) {
    throw new AppError("This plan is not available.", { status: 404, code: "PLAN_NOT_FOUND" });
  }

  const usage = await loadSeatUsage(access.tenantId);
  if (seats < usage.active_members) {
    throw new AppError(`Your company already has ${usage.active_members} members, so choose at least ${usage.active_members} seats.`, {
      status: 400,
      code: "SEATS_BELOW_MEMBERS",
      details: { minimumSeats: usage.active_members },
    });
  }

  const { data: existing, error: existingError } = await db
    .from("billing_subscriptions")
    .select("billing_subscription_id,razorpay_subscription_id,razorpay_status")
    .eq("tenant_id", access.tenantId)
    .in("razorpay_status", ["created", ...LIVE_STATUSES]);

  if (existingError) {
    throw new AppError("Billing details could not be loaded.", { status: 500, code: "BILLING_LOAD_FAILED", retryable: true });
  }

  const rows = (existing ?? []) as { billing_subscription_id: string; razorpay_subscription_id: string; razorpay_status: string }[];
  if (rows.some((row) => (LIVE_STATUSES as readonly string[]).includes(row.razorpay_status))) {
    throw new AppError("This company already has a subscription.", { status: 409, code: "SUBSCRIPTION_ALREADY_EXISTS" });
  }

  const razorpay = getRazorpayClient();

  for (const abandoned of rows.filter((row) => row.razorpay_status === "created")) {
    await retireAbandonedSubscription(abandoned.billing_subscription_id, abandoned.razorpay_subscription_id);
  }

  const subscription = await razorpay.createSubscription({
    planId: plan.razorpay_plan_id,
    quantity: seats,
    totalCount: plan.total_count,
    expireBy: Math.floor(Date.now() / 1000) + CHECKOUT_WINDOW_SECONDS,
    notes: { tenant_id: access.tenantId, billing_plan_code: plan.plan_code },
  });

  const { error: insertError } = await db.from("billing_subscriptions").insert({
    tenant_id: access.tenantId,
    billing_plan_id: plan.billing_plan_id,
    razorpay_subscription_id: subscription.id,
    seat_quantity: seats,
    razorpay_status: subscription.status,
    created_by_user_id: access.userId,
  });

  if (insertError) {
    // Without this row the webhook could never map a payment to the tenant, so the checkout must not
    // open. Cancel the orphan so it cannot be paid.
    logBillingEvent("SUBSCRIPTION_RECORD_FAILED", { razorpaySubscriptionId: subscription.id });
    await razorpay.cancelSubscription(subscription.id, { atCycleEnd: false }).catch(() => {
      logBillingEvent("ORPHAN_SUBSCRIPTION_CANCEL_FAILED", { razorpaySubscriptionId: subscription.id });
    });
    throw new AppError("Checkout could not be started. Please try again.", { status: 500, code: "CHECKOUT_FAILED", retryable: true });
  }

  return {
    subscriptionId: subscription.id,
    keyId: getRazorpayEnv().RAZORPAY_KEY_ID,
    planName: plan.plan_name,
    seats,
    amountPaise: plan.price_per_seat_paise * seats,
    companyName: access.tenantName,
  };
}

async function retireAbandonedSubscription(billingSubscriptionId: string, razorpaySubscriptionId: string): Promise<void> {
  const db = getSupabaseAdminClient();
  const razorpay = getRazorpayClient();

  let status: RazorpaySubscriptionStatus;
  try {
    status = (await razorpay.cancelSubscription(razorpaySubscriptionId, { atCycleEnd: false })).status;
  } catch {
    // Already expired/cancelled on Razorpay's side, or Razorpay is down: ask for the truth.
    status = (await razorpay.fetchSubscription(razorpaySubscriptionId)).status;
  }

  await db.from("billing_subscriptions").update({ razorpay_status: status }).eq("billing_subscription_id", billingSubscriptionId);

  if (status === "created" || (LIVE_STATUSES as readonly string[]).includes(status)) {
    // Could not retire it (or it was just paid). Opening a second checkout now risks double billing.
    throw new AppError("A previous checkout is still being processed. Please try again in a few minutes.", {
      status: 409,
      code: "PREVIOUS_CHECKOUT_PENDING",
      retryable: true,
    });
  }
}

/**
 * Cancels at the end of the current billing cycle: Razorpay stops future charges and the company keeps
 * access until current_period_ends_at, after which evaluateCrmAccess() closes it on its own. Razorpay
 * refuses cycle-end cancellation in `created`/`authenticated`, so only an `active` subscription qualifies.
 */
export async function cancelAtPeriodEnd(access: BillingAccess): Promise<{ periodEndsAt: string | null }> {
  requireOwner(access);
  const db = getSupabaseAdminClient();
  const current = await loadCurrentSubscription(access.tenantId);

  if (!current || current.razorpay_status !== "active") {
    throw new AppError("There is no active subscription to cancel.", { status: 409, code: "NO_ACTIVE_SUBSCRIPTION" });
  }
  if (current.cancel_at_period_end) {
    return { periodEndsAt: current.current_period_end };
  }

  const cancelled = await getRazorpayClient().cancelSubscription(current.razorpay_subscription_id, { atCycleEnd: true });

  const { error } = await db
    .from("billing_subscriptions")
    .update({ razorpay_status: cancelled.status, cancel_at_period_end: true })
    .eq("billing_subscription_id", current.billing_subscription_id)
    .eq("tenant_id", access.tenantId);

  if (error) {
    // Razorpay has already cancelled; our copy is stale but access dates are unaffected.
    logBillingEvent("CANCEL_RECORD_FAILED", { razorpaySubscriptionId: current.razorpay_subscription_id });
  }

  return { periodEndsAt: current.current_period_end };
}

interface CurrentSubscriptionRow {
  billing_subscription_id: string;
  razorpay_subscription_id: string;
  razorpay_status: RazorpaySubscriptionStatus;
  seat_quantity: number;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  billing_plans: { plan_name: string; billing_period: "monthly" | "yearly"; price_per_seat_paise: number } | null;
}

/** The subscription currently paying for this tenant's access card, if any. */
async function loadCurrentSubscription(tenantId: string): Promise<CurrentSubscriptionRow | null> {
  const db = getSupabaseAdminClient();

  const { data: card, error: cardError } = await db
    .from("tenants_subscriptions")
    .select("active_billing_subscription_id")
    .eq("tenant_id", tenantId)
    .maybeSingle<{ active_billing_subscription_id: string | null }>();

  if (cardError) {
    throw new AppError("Billing details could not be loaded.", { status: 500, code: "BILLING_LOAD_FAILED", retryable: true });
  }
  if (!card?.active_billing_subscription_id) {
    return null;
  }

  const { data, error } = await db
    .from("billing_subscriptions")
    .select(
      "billing_subscription_id,razorpay_subscription_id,razorpay_status,seat_quantity,current_period_end,cancel_at_period_end,billing_plans(plan_name,billing_period,price_per_seat_paise)",
    )
    .eq("billing_subscription_id", card.active_billing_subscription_id)
    .eq("tenant_id", tenantId)
    .maybeSingle<CurrentSubscriptionRow>();

  if (error) {
    throw new AppError("Billing details could not be loaded.", { status: 500, code: "BILLING_LOAD_FAILED", retryable: true });
  }
  return data ?? null;
}

export interface BillingPlanOption {
  planCode: string;
  planName: string;
  billingPeriod: "monthly" | "yearly";
  pricePerSeatPaise: number;
}

export interface BillingPaymentRecord {
  paymentId: string;
  amountPaise: number;
  currency: string;
  paymentMethod: string | null;
  periodStart: string;
  periodEnd: string;
  paidAt: string;
  invoiceUrl: string | null;
}

export interface BillingOverview {
  companyName: string;
  isOwner: boolean;
  hasCrmAccess: boolean;
  subscriptionStatus: string;
  trialEndsAt: string | null;
  currentPeriodEndsAt: string | null;
  seats: { paidSeats: number | null; activeMembers: number; pendingInvitations: number };
  currentPlan: {
    planName: string;
    billingPeriod: "monthly" | "yearly";
    pricePerSeatPaise: number;
    seatQuantity: number;
    razorpayStatus: RazorpaySubscriptionStatus;
    cancelAtPeriodEnd: boolean;
  } | null;
  /** True when the owner may start a new checkout (no live subscription). */
  canSubscribe: boolean;
  plans: BillingPlanOption[];
  /** Owner only; empty for employees. */
  payments: BillingPaymentRecord[];
}

export async function getBillingOverview(access: BillingAccess): Promise<BillingOverview> {
  const db = getSupabaseAdminClient();
  const isOwner = access.membershipRole === "owner";

  const [current, usage, plansResult, payments] = await Promise.all([
    loadCurrentSubscription(access.tenantId),
    loadSeatUsage(access.tenantId),
    db
      .from("billing_plans")
      .select("plan_code,plan_name,billing_period,price_per_seat_paise")
      .eq("is_active", true)
      .order("price_per_seat_paise", { ascending: true }),
    isOwner ? listBillingPayments(access) : Promise.resolve([]),
  ]);

  if (plansResult.error) {
    throw new AppError("Billing details could not be loaded.", { status: 500, code: "BILLING_LOAD_FAILED", retryable: true });
  }

  const isLive = current !== null && (LIVE_STATUSES as readonly string[]).includes(current.razorpay_status);

  return {
    companyName: access.tenantName,
    isOwner,
    hasCrmAccess: access.hasCrmAccess,
    subscriptionStatus: access.subscriptionStatus,
    trialEndsAt: access.trialEndsAt,
    currentPeriodEndsAt: access.currentPeriodEndsAt,
    seats: {
      paidSeats: usage.paid_seats,
      activeMembers: usage.active_members,
      pendingInvitations: usage.pending_invitations,
    },
    currentPlan:
      current && current.billing_plans
        ? {
            planName: current.billing_plans.plan_name,
            billingPeriod: current.billing_plans.billing_period,
            pricePerSeatPaise: current.billing_plans.price_per_seat_paise,
            seatQuantity: current.seat_quantity,
            razorpayStatus: current.razorpay_status,
            cancelAtPeriodEnd: current.cancel_at_period_end,
          }
        : null,
    canSubscribe: isOwner && !isLive,
    plans: ((plansResult.data ?? []) as { plan_code: string; plan_name: string; billing_period: "monthly" | "yearly"; price_per_seat_paise: number }[]).map(
      (row) => ({
        planCode: row.plan_code,
        planName: row.plan_name,
        billingPeriod: row.billing_period,
        pricePerSeatPaise: row.price_per_seat_paise,
      }),
    ),
    payments,
  };
}

/**
 * Owner-only: every receipt for the caller's active company, newest first, in one list (a monthly plan
 * adds only 12 a year). The UI shows them in a scrollable box rather than paginating. Each row links to
 * the Razorpay-hosted invoice for that payment.
 */
export async function listBillingPayments(access: BillingAccess): Promise<BillingPaymentRecord[]> {
  requireOwner(access);

  const { data, error } = await getSupabaseAdminClient()
    .from("billing_payments")
    .select("razorpay_payment_id,amount_paise,currency,payment_method,period_start,period_end,paid_at,invoice_url")
    .eq("tenant_id", access.tenantId)
    .order("paid_at", { ascending: false });

  if (error) {
    throw new AppError("Invoices could not be loaded.", { status: 500, code: "BILLING_LOAD_FAILED", retryable: true });
  }

  return (
    (data ?? []) as {
      razorpay_payment_id: string;
      amount_paise: number;
      currency: string;
      payment_method: string | null;
      period_start: string;
      period_end: string;
      paid_at: string;
      invoice_url: string | null;
    }[]
  ).map((row) => ({
    paymentId: row.razorpay_payment_id,
    amountPaise: row.amount_paise,
    currency: row.currency,
    paymentMethod: row.payment_method,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    paidAt: row.paid_at,
    invoiceUrl: row.invoice_url,
  }));
}

function requireOwner(access: BillingAccess): void {
  if (access.membershipRole !== "owner") {
    throw new AppError("Only the company owner can manage billing.", { status: 403, code: "BILLING_OWNER_REQUIRED" });
  }
}

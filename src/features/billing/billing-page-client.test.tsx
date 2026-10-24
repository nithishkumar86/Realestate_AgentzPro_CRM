import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingOverview } from "@/lib/server/billing-service";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));

const startCheckout = vi.fn();
const getBillingStatus = vi.fn();
const cancelSubscriptionAtPeriodEnd = vi.fn();
vi.mock("@/services/billing-api-client", () => ({
  startCheckout: (...args: unknown[]) => startCheckout(...args),
  getBillingStatus: (...args: unknown[]) => getBillingStatus(...args),
  cancelSubscriptionAtPeriodEnd: (...args: unknown[]) => cancelSubscriptionAtPeriodEnd(...args),
}));

const { BillingPageClient } = await import("@/features/billing/billing-page-client");

const KEY = "agentzpro:billing:pending-activation";
const TENANT = "tenant-1";
const NOW = new Date("2026-10-16T08:00:00Z").getTime();

function overview(patch: Partial<BillingOverview> = {}): BillingOverview {
  return {
    tenantId: TENANT,
    companyName: "QA Test Co",
    isOwner: true,
    hasCrmAccess: true,
    subscriptionStatus: "trialing",
    trialEndsAt: "2026-10-30T00:00:00Z",
    currentPeriodEndsAt: null,
    seats: { paidSeats: null, activeMembers: 1, pendingInvitations: 0 },
    currentPlan: null,
    canSubscribe: true,
    plans: [{ planCode: "pro_monthly", planName: "Pro Monthly", billingPeriod: "monthly", pricePerSeatPaise: 49900 }],
    payments: [],
    ...patch,
  } as BillingOverview;
}

const PENDING_STATUS = { subscriptionStatus: "trialing", hasCrmAccess: true, currentPeriodEndsAt: null };
const ACTIVE_STATUS = { subscriptionStatus: "active", hasCrmAccess: true, currentPeriodEndsAt: "2026-11-15T18:30:00Z" };

function storeMarker(patch: Record<string, unknown> = {}) {
  window.localStorage.setItem(
    KEY,
    JSON.stringify({ tenantId: TENANT, paymentId: "pay_STORED", startedAt: NOW - 60_000, previousPeriodEndsAt: null, ...patch }),
  );
}

/** Lets the mount microtask and any pending promise callbacks run. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const payButton = () => screen.queryByRole("button", { name: /Pay/ });

describe("BillingPageClient: after payment", () => {
  let razorpayOptions: { handler: (response: Record<string, string>) => void; modal?: { ondismiss?: () => void } } | null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    window.localStorage.clear();
    razorpayOptions = null;
    window.Razorpay = vi.fn().mockImplementation(function (options) {
      razorpayOptions = options;
      return { open: vi.fn() };
    }) as unknown as typeof window.Razorpay;
    startCheckout.mockResolvedValue({
      subscriptionId: "sub_1",
      keyId: "rzp_live_x",
      planName: "Pro Monthly",
      seats: 1,
      amountPaise: 49900,
      companyName: "QA Test Co",
    });
    getBillingStatus.mockResolvedValue(PENDING_STATUS);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.Razorpay;
  });

  async function payAndSucceed() {
    fireEvent.click(payButton()!);
    await flush();
    act(() => razorpayOptions!.handler({ razorpay_payment_id: "pay_NEW", razorpay_subscription_id: "sub_1", razorpay_signature: "sig" }));
  }

  it("shows a clear 'payment processing, activating' message and hides Pay once Razorpay reports success", async () => {
    render(<BillingPageClient overview={overview()} />);
    await flush();
    await payAndSucceed();

    expect(screen.getByRole("heading", { name: "Your payment is processing" })).toBeInTheDocument();
    expect(screen.getByText("Payment submitted")).toBeInTheDocument();
    expect(screen.getByText("Activating your plan")).toBeInTheDocument();
    expect(screen.getByText(/please do not pay again/)).toBeInTheDocument();
    expect(screen.getByText("pay_NEW")).toBeInTheDocument();
    expect(screen.queryByText(/razorpay/i)).not.toBeInTheDocument();
    expect(payButton()).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toMatchObject({ tenantId: TENANT, paymentId: "pay_NEW", startedAt: NOW });
  });

  it("keeps waiting well past the old 30 seconds, then opens the CRM when the plan activates", async () => {
    render(<BillingPageClient overview={overview()} />);
    await flush();
    await payAndSucceed();

    await advance(10 * 60_000);
    expect(screen.getByRole("heading", { name: "Your payment is processing" })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();

    getBillingStatus.mockResolvedValue(ACTIVE_STATUS);
    await advance(20_000);

    expect(replace).toHaveBeenCalledWith("/leads");
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("does not remember anything when checkout is closed without paying", async () => {
    render(<BillingPageClient overview={overview()} />);
    await flush();
    fireEvent.click(payButton()!);
    await flush();
    act(() => razorpayOptions!.modal!.ondismiss!());

    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(payButton()).toBeEnabled();
  });

  it("after a reload, resumes the processing screen instead of offering Pay again", async () => {
    storeMarker();
    render(<BillingPageClient overview={overview()} />);
    await flush();

    expect(screen.getByRole("heading", { name: "Your payment is processing" })).toBeInTheDocument();
    expect(screen.getByText("pay_STORED")).toBeInTheDocument();
    expect(payButton()).not.toBeInTheDocument();
  });

  it("keeps Pay disabled until this browser has been checked for a pending payment", async () => {
    render(<BillingPageClient overview={overview()} />);
    expect(payButton()).toBeDisabled();
    await flush();
    expect(payButton()).toBeEnabled();
  });

  it("ignores a marker from another company (leaving it for them) or one past the activation window", async () => {
    storeMarker({ tenantId: "someone-else" });
    const { unmount } = render(<BillingPageClient overview={overview()} />);
    await flush();
    expect(payButton()).toBeEnabled();
    expect(window.localStorage.getItem(KEY)).toContain("someone-else");
    unmount();

    storeMarker({ startedAt: NOW - 31 * 60_000 });
    render(<BillingPageClient overview={overview()} />);
    await flush();
    expect(payButton()).toBeEnabled();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("clears the marker when the page loads already activated", async () => {
    storeMarker();
    render(
      <BillingPageClient
        overview={overview({ subscriptionStatus: "active", currentPeriodEndsAt: ACTIVE_STATUS.currentPeriodEndsAt, canSubscribe: false })}
      />,
    );
    await flush();

    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Your payment is processing" })).not.toBeInTheDocument();
  });

  it("if activation takes too long, reassures the customer, offers contact, and never brings Pay back by itself", async () => {
    storeMarker({ startedAt: NOW });
    render(<BillingPageClient overview={overview()} />);
    await flush();
    await advance(31 * 60_000);

    expect(screen.getByRole("heading", { name: "Your payment is safe" })).toBeInTheDocument();
    expect(screen.getByText(/You do not need to pay again/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Contact us" })).toHaveAttribute("href", "/contact");
    expect(payButton()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await flush();
    expect(screen.getByText(/Still being confirmed/)).toBeInTheDocument();
    expect(payButton()).not.toBeInTheDocument();

    getBillingStatus.mockResolvedValue(ACTIVE_STATUS);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await flush();
    expect(replace).toHaveBeenCalledWith("/leads");
  });

  it("inside Settings, reloads the billing panel on activation instead of navigating", async () => {
    const onChanged = vi.fn();
    storeMarker();
    getBillingStatus.mockResolvedValue(ACTIVE_STATUS);
    render(<BillingPageClient overview={overview()} embedded onChanged={onChanged} />);
    await flush();
    await advance(5_000);

    expect(onChanged).toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not show an employee the processing screen", async () => {
    storeMarker();
    render(<BillingPageClient overview={overview({ isOwner: false, canSubscribe: false })} />);
    await flush();

    expect(screen.queryByRole("heading", { name: "Your payment is processing" })).not.toBeInTheDocument();
    expect(screen.getByText("Only the company owner can manage billing.")).toBeInTheDocument();
  });
});

describe("BillingPageClient: cancel auto-renewal wording", () => {
  const ACTIVE_PLAN = {
    planName: "Pro Monthly",
    billingPeriod: "monthly" as const,
    pricePerSeatPaise: 49900,
    seatQuantity: 3,
    razorpayStatus: "active" as const,
    cancelAtPeriodEnd: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("names what the button does and states the no-refund rule before cancelling, without calling the API early", async () => {
    render(
      <BillingPageClient
        overview={overview({ subscriptionStatus: "active", currentPeriodEndsAt: "2026-11-15T18:30:00Z", currentPlan: ACTIVE_PLAN, canSubscribe: false })}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Not "Cancel subscription": that wording implied a refund to the user.
    expect(screen.queryByRole("button", { name: "Cancel subscription" })).not.toBeInTheDocument();
    const openButton = screen.getByRole("button", { name: "Cancel auto-renewal" });
    expect(cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();

    fireEvent.click(openButton);

    // The date also appears in the summary above ("Renews on"), so this checks the confirm paragraph only.
    const confirmText = screen.getByText(/Your plan will not renew/);
    expect(confirmText).toHaveTextContent("Your plan will not renew, and the company keeps access until");
    expect(confirmText).toHaveTextContent("Nov 2026");
    expect(confirmText).toHaveTextContent("Payments already made are not refunded.");
    expect(cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel auto-renewal" }));
    expect(cancelSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(1);

    // Let handleCancel's await settle before the test ends, so its state update is inside act().
    await act(async () => {
      await Promise.resolve();
    });
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BillingOverview } from "@/lib/server/billing-service";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/services/billing-api-client", () => ({
  startCheckout: vi.fn(),
  getBillingStatus: vi.fn(),
  cancelSubscriptionAtPeriodEnd: vi.fn(),
}));

const { BillingPageClient } = await import("@/features/billing/billing-page-client");

function overview(razorpayStatus: "active" | "halted" | "cancelled", canSubscribe: boolean): BillingOverview {
  return {
    tenantId: "tenant-1",
    companyName: "QA Test Co",
    isOwner: true,
    hasCrmAccess: true,
    subscriptionStatus: "active",
    trialEndsAt: null,
    currentPeriodEndsAt: "2026-11-22T18:30:00Z",
    seats: { paidSeats: 1, activeMembers: 1, pendingInvitations: 0 },
    currentPlan: {
      planName: "Pro Monthly",
      billingPeriod: "monthly",
      pricePerSeatPaise: 49900,
      seatQuantity: 1,
      razorpayStatus,
      cancelAtPeriodEnd: false,
    },
    canSubscribe,
    plans: [{ planCode: "pro_monthly", planName: "Pro Monthly", billingPeriod: "monthly", pricePerSeatPaise: 49900 }],
    payments: [],
  } as BillingOverview;
}

describe("BillingPageClient: autopay stopped while the paid month runs", () => {
  it.each(["halted", "cancelled"] as const)("says access ends (not renews), offers no Pay and no cancel (%s)", (status) => {
    render(<BillingPageClient overview={overview(status, false)} />);

    expect(screen.getByText("Access ends on")).toBeInTheDocument();
    expect(screen.queryByText("Renews on")).not.toBeInTheDocument();
    expect(screen.getByText("Ending")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pay/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument();
  });

  it("still says the plan renews while autopay is active", () => {
    render(<BillingPageClient overview={overview("active", false)} />);

    expect(screen.getByText("Renews on")).toBeInTheDocument();
    expect(screen.getByText("Your plan")).toBeInTheDocument();
    expect(screen.queryByText("Ending")).not.toBeInTheDocument();
  });
});

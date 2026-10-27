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

function overview(isInternal: boolean): BillingOverview {
  return {
    tenantId: "tenant-1",
    companyName: "QA Test Co",
    isOwner: true,
    hasCrmAccess: true,
    isInternal,
    subscriptionStatus: "trialing",
    trialEndsAt: "2026-11-05T04:10:59Z",
    currentPeriodEndsAt: null,
    seats: { paidSeats: isInternal ? 10 : null, activeMembers: 2, pendingInvitations: 1 },
    currentPlan: null,
    canSubscribe: !isInternal,
    plans: [{ planCode: "pro_monthly", planName: "Pro Monthly", billingPeriod: "monthly", pricePerSeatPaise: 49900 }],
    payments: [],
  };
}

describe("BillingPageClient: internal company account", () => {
  it("shows Internal account with its seats, and no trial or Pay", () => {
    render(<BillingPageClient overview={overview(true)} />);

    expect(screen.getByText("Internal account")).toBeInTheDocument();
    expect(screen.getByText("3 of 10 used")).toBeInTheDocument();
    expect(screen.getByText("No payment needed: this is an internal company account.")).toBeInTheDocument();
    expect(screen.queryByText("Free trial")).not.toBeInTheDocument();
    expect(screen.queryByText("Trial ends")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pay/ })).not.toBeInTheDocument();
  });

  it("leaves a normal trial company unchanged: trial shown and Pay offered", () => {
    render(<BillingPageClient overview={overview(false)} />);

    expect(screen.getByText("Free trial")).toBeInTheDocument();
    expect(screen.getByText("Trial ends")).toBeInTheDocument();
    expect(screen.queryByText("Internal account")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pay/ })).toBeInTheDocument();
  });
});

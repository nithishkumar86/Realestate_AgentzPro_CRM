import type { Metadata } from "next";
import { PricingView } from "@/features/pricing/pricing-view";
import { listActivePlans, type BillingPlanOption } from "@/lib/server/billing-service";

export const metadata: Metadata = {
  title: "Pricing | AgentzPro CRM",
  description: "Start with a 14-day free trial, then pay per seat for AgentzPro CRM Pro — monthly or yearly.",
};

// Prices come from billing_plans; re-read every 5 minutes so a price change reaches this page quickly.
export const revalidate = 300;

/**
 * Public pricing page. Both offers start at /login: the free trial begins when a new company finishes
 * onboarding, and Pro is bought by the company owner from Settings → Billing once signed in.
 */
export default async function PricingPage() {
  return <PricingView plans={await loadPlans()} />;
}

async function loadPlans(): Promise<BillingPlanOption[]> {
  try {
    return await listActivePlans();
  } catch {
    // The page still works without prices: the Pro card falls back to "see pricing after login".
    return [];
  }
}

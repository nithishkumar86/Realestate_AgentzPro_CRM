import "server-only";

import { z } from "zod";
import { AppError } from "@/lib/server/app-error";
import { createAuthClient } from "@/lib/server/auth/supabase-auth-client";
import { normalizeIndianPhone } from "@/lib/server/lead-query-service";

/**
 * Validates and normalizes the four onboarding fields, then calls the
 * `complete_owner_onboarding` RPC (login_system_plan.md section 6.4),
 * which is the sole writer for the profiles/tenants/tenant_memberships/
 * tenants_subscriptions rows. This module never writes those tables
 * directly.
 *
 * This service assumes its caller (the /api/auth/onboarding route handler)
 * has already verified the request is authenticated — the RPC itself is
 * also session-scoped (it reads auth.uid() from the caller's own JWT via
 * the cookie-bound client below), so an unauthenticated call is rejected
 * by Postgres regardless, but the route handler should reject it earlier
 * with a clearer 401 for anyone hitting this endpoint directly.
 */
const onboardingInputSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  phoneNumber: z.string().trim().min(1).max(20),
  companyName: z.string().trim().min(1).max(200),
  professionalRole: z.string().trim().min(1).max(120),
});

export type OnboardingInput = z.infer<typeof onboardingInputSchema>;

export interface OnboardingResult {
  tenantId: string;
  subscriptionStatus: string;
}

interface CompleteOwnerOnboardingRow {
  tenant_id: string;
  subscription_status: string;
}

export async function completeOwnerOnboarding(rawInput: unknown): Promise<OnboardingResult> {
  const parseResult = onboardingInputSchema.safeParse(rawInput);
  if (!parseResult.success) {
    throw new AppError("Onboarding details are invalid.", { status: 400, code: "INVALID_ONBOARDING_INPUT" });
  }

  const input = parseResult.data;
  const normalizedPhone = normalizeIndianPhone(input.phoneNumber);
  if (!normalizedPhone) {
    throw new AppError("A valid phone number is required.", { status: 400, code: "INVALID_PHONE_NUMBER" });
  }

  const supabase = await createAuthClient();
  const { data, error } = await supabase.rpc("complete_owner_onboarding", {
    p_full_name: input.fullName,
    p_phone_number: normalizedPhone,
    p_tenant_name: input.companyName,
    p_professional_role: input.professionalRole,
  });

  if (error) {
    throw new AppError("Onboarding could not be completed.", { status: 500, code: "ONBOARDING_FAILED" });
  }

  // The RPC is declared `returns table (...)`, so PostgREST returns an
  // array of rows even though this function always produces exactly one.
  const row: CompleteOwnerOnboardingRow | undefined = Array.isArray(data) ? data[0] : data;
  if (!row?.tenant_id) {
    throw new AppError("Onboarding could not be completed.", { status: 500, code: "ONBOARDING_FAILED" });
  }

  return { tenantId: row.tenant_id, subscriptionStatus: row.subscription_status };
}

import { createSuccessResponse, createErrorResponse } from "@/app/api/meta/_lib/route-utils";
import { AppError } from "@/lib/server/app-error";
import { isConstantTimeMatch } from "@/lib/server/webhook-security";
import { getAuthEnv } from "@/lib/server/env";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const runtime = "nodejs";

const CRON_SECRET_HEADER = "x-cron-secret";

/**
 * Hourly trial/subscription reconciliation (login_system_plan.md section
 * 7). This keeps the stored subscription_status readable for the UI and
 * reports; it is not the security boundary. private.has_crm_access() in
 * Postgres evaluates trial_ends_at / current_period_ends_at directly, so
 * access is still denied at the exact expiry instant even if this cron
 * has never run or has failed.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const suppliedSecret = request.headers.get(CRON_SECRET_HEADER);
    const expectedSecret = getAuthEnv().SUBSCRIPTION_CRON_SECRET;

    if (!suppliedSecret || !isConstantTimeMatch(expectedSecret, suppliedSecret)) {
      throw new AppError("The request could not be authenticated.", { status: 403, code: "CRON_UNAUTHORIZED" });
    }

    const { data, error } = await getSupabaseAdminClient().rpc("reconcile_tenant_subscriptions");
    if (error) {
      throw new AppError("Subscription reconciliation failed.", { status: 500, code: "RECONCILIATION_FAILED" });
    }

    return createSuccessResponse({ updatedCount: data ?? 0 });
  } catch (error) {
    return createErrorResponse(error);
  }
}

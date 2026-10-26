import "server-only";

import { AppError } from "@/lib/server/app-error";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import type { TenantRequestContext } from "@/lib/server/tenant-context";

export interface CallInLeadInput { leadName: string; phone: string; whatsapp?: string; projectName: string }

/**
 * Adds a call-in lead (a lead a member took over the phone). The create_telecaller_lead RPC does the whole
 * write in one transaction: membership check, duplicate-phone check, insert, classification row (no AI), and
 * assignment to the person who added it.
 */
export async function createTelecallerLead(context: TenantRequestContext, input: CallInLeadInput): Promise<{ id: string }> {
  const { data, error } = await getSupabaseAdminClient().rpc("create_telecaller_lead", {
    p_tenant_id: context.tenantId,
    p_actor_user_id: context.userId,
    p_lead_name: input.leadName,
    p_phone: input.phone,
    p_whatsapp: input.whatsapp ?? null,
    p_project_name: input.projectName,
  });
  if (error) {
    if (error.code === "42501") throw new AppError("You are not allowed to add leads for this company.", { status: 403, code: "LEAD_CREATE_FORBIDDEN" });
    if (error.code === "P0001" && error.message === "LEAD_PHONE_EXISTS") throw new AppError("This phone number already exists as a lead.", { status: 409, code: "LEAD_PHONE_EXISTS" });
    if (error.code === "22023") throw new AppError(error.message || "Lead details are invalid.", { status: 400, code: "INVALID_LEAD" });
    throw new AppError("The lead could not be saved.", { status: 500, code: "LEAD_CREATE_FAILED" });
  }
  if (typeof data !== "string") throw new AppError("The lead could not be saved.", { status: 500, code: "LEAD_CREATE_FAILED" });
  return { id: data };
}

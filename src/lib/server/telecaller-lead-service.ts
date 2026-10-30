import "server-only";

import { CALL_IN_PLATFORMS, LEAD_SOURCE_LABELS, type CallInPlatform } from "@/features/leads/lead-options";
import { AppError } from "@/lib/server/app-error";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import type { TenantRequestContext } from "@/lib/server/tenant-context";

export interface CallInLeadInput {
  leadName: string; phone: string; whatsapp?: string; projectName: string;
  /** Where the person came from; required by the database whenever the company has a platform connected. */
  cameFromPlatform?: CallInPlatform;
  /** One of the company's named ads (Facebook) or campaigns (Google Ads) on that platform. */
  cameFromRefId?: string;
  /** YYYY-MM-DD in the company's timezone; left out = today. */
  callDate?: string;
}

/** One platform the "+" form offers: connected right now, with the named ads or campaigns a lead can be credited to. */
export interface CallInOrigin { id: CallInPlatform; label: string; refs: Array<{ id: string; name: string }> }
export interface CallInOrigins { today: string; minDate: string; platforms: CallInOrigin[] }

const ORIGIN_CHANGED_MESSAGE = "The connected lead platforms or ads changed. Check \"Came from\" and save again.";

/**
 * Adds a call-in lead (a lead a member took over the phone). The create_call_in_lead RPC does the whole write in one
 * transaction: membership check, "Came from" and call-date checks, duplicate-phone check, insert, classification row
 * (no AI), and assignment to the person who added it.
 */
export async function createTelecallerLead(context: TenantRequestContext, input: CallInLeadInput): Promise<{ id: string }> {
  const { data, error } = await getSupabaseAdminClient().rpc("create_call_in_lead", {
    p_tenant_id: context.tenantId,
    p_actor_user_id: context.userId,
    p_lead_name: input.leadName,
    p_phone: input.phone,
    p_whatsapp: input.whatsapp ?? null,
    p_project_name: input.projectName,
    p_came_from_platform: input.cameFromPlatform ?? null,
    p_came_from_ref_id: input.cameFromRefId ?? null,
    p_call_date: input.callDate ?? null,
  });
  if (error) {
    if (error.code === "42501") throw new AppError("You are not allowed to add leads for this company.", { status: 403, code: "LEAD_CREATE_FORBIDDEN" });
    if (error.code === "P0001" && error.message === "LEAD_PHONE_EXISTS") throw new AppError("This phone number already exists as a lead.", { status: 409, code: "LEAD_PHONE_EXISTS" });
    if (error.code === "P0001" && error.message === "CALL_IN_ORIGIN_CHANGED") throw new AppError(ORIGIN_CHANGED_MESSAGE, { status: 409, code: "CALL_IN_ORIGIN_CHANGED" });
    if (error.code === "22023") throw new AppError(error.message || "Lead details are invalid.", { status: 400, code: "INVALID_LEAD" });
    throw new AppError("The lead could not be saved.", { status: 500, code: "LEAD_CREATE_FAILED" });
  }
  if (typeof data !== "string") throw new AppError("The lead could not be saved.", { status: 500, code: "LEAD_CREATE_FAILED" });
  return { id: data };
}

/** What the "+" form offers for "Came from" and the call date. The database decides which platforms are connected. */
export async function listCallInOrigins(context: TenantRequestContext): Promise<CallInOrigins> {
  const { data, error } = await getSupabaseAdminClient().rpc("list_call_in_origins", { p_tenant_id: context.tenantId });
  const result = data as { today?: unknown; minDate?: unknown; platforms?: unknown } | null;
  if (error || !result || typeof result.today !== "string" || typeof result.minDate !== "string" || !Array.isArray(result.platforms)) {
    throw new AppError("Lead platforms could not be loaded.", { status: 500, code: "CALL_IN_ORIGINS_FAILED" });
  }
  const platforms: CallInOrigin[] = [];
  for (const entry of result.platforms as Array<{ id?: unknown; refs?: unknown }>) {
    const id = CALL_IN_PLATFORMS.find((platform) => platform === entry?.id);
    if (!id) continue;
    const refs = (Array.isArray(entry.refs) ? entry.refs : []).flatMap((ref: { id?: unknown; name?: unknown }) =>
      typeof ref?.id === "string" && typeof ref.name === "string" ? [{ id: ref.id, name: ref.name }] : []);
    platforms.push({ id, label: LEAD_SOURCE_LABELS[id], refs });
  }
  return { today: result.today, minDate: result.minDate, platforms };
}

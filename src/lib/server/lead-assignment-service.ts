import "server-only";

import type { CrmAccessGranted } from "@/lib/server/auth/access";
import { AppError } from "@/lib/server/app-error";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import type { TenantRequestContext } from "@/lib/server/tenant-context";

/**
 * Lead assignment by ad (migration 20261006120000_lead_assignment_by_ad.sql).
 *
 * New leads are assigned by a database trigger from the owner's per-ad rule; this module only reads the
 * rules and writes through the service-role RPCs. Every call is pinned to the tenant from the verified
 * session, and the actor comes from that session — never from the request. The RPCs re-check that the
 * actor is an active member (or the active owner, for rules) and that the assignee is an active member of
 * the same tenant.
 */

export interface AssignableMember { userId: string; fullName: string; }

export interface AdAssignment {
  adId: string;
  adName: string | null;
  assigneeUserId: string | null;
  totalLeads: number;
  unassignedLeads: number;
}

export interface AdAssignmentOverview { ads: AdAssignment[]; members: AssignableMember[]; }

const OWNER_ONLY = "Only the company owner can manage ad assignment.";

/** Active members of the tenant — the only people a lead can be assigned to. Names fall back to "Team member". */
export async function listAssignableMembers(tenantId: string): Promise<AssignableMember[]> {
  const db = getSupabaseAdminClient();
  const { data: memberships, error } = await db.from("tenant_memberships")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .eq("membership_status", "active");
  if (error) throw new AppError("Team members could not be loaded.", { status: 500, code: "ASSIGNEES_LOAD_FAILED" });
  const userIds = (memberships ?? []).map((row) => String(row.user_id));
  const names = await loadProfileNames(userIds);
  return userIds
    .map((userId) => ({ userId, fullName: names.get(userId) ?? "Team member" }))
    .sort((left, right) => left.fullName.localeCompare(right.fullName) || left.userId.localeCompare(right.userId));
}

/** user id -> full name for the given people. Callers only pass ids that came from tenant-scoped rows. */
export async function loadProfileNames(userIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const { data, error } = await getSupabaseAdminClient().from("profiles").select("user_id,full_name").in("user_id", unique);
  if (error) throw new AppError("Team members could not be loaded.", { status: 500, code: "ASSIGNEES_LOAD_FAILED" });
  const names = new Map<string, string>();
  for (const row of data ?? []) {
    const name = typeof row.full_name === "string" ? row.full_name.trim() : "";
    if (name) names.set(String(row.user_id), name);
  }
  return names;
}

/** Assigns (or, with null, unassigns) one lead. Any active member may do it, like a status change. */
export async function assignLead(
  context: TenantRequestContext,
  leadId: string,
  assigneeUserId: string | null,
): Promise<{ id: string; assignedUserId: string | null; assigneeName: string | null }> {
  const { data, error } = await getSupabaseAdminClient().rpc("assign_lead", {
    p_tenant_id: context.tenantId, p_lead_id: leadId, p_assignee_user_id: assigneeUserId, p_actor_user_id: context.userId,
  });
  if (error) {
    if (error.code === "42501") throw new AppError("You are not allowed to assign leads for this company.", { status: 403, code: "LEAD_ASSIGN_FORBIDDEN" });
    if (error.code === "22023") throw new AppError("Choose an active member of this company.", { status: 400, code: "INVALID_ASSIGNEE" });
    throw new AppError("The lead could not be assigned.", { status: 500, code: "LEAD_ASSIGN_FAILED" });
  }
  const row = (Array.isArray(data) ? data[0] : data) as { lead_id: string; lead_assignee_user_id: string | null } | null | undefined;
  if (!row) throw new AppError("Lead not found for this tenant.", { status: 404, code: "LEAD_NOT_FOUND" });
  const assignedUserId = row.lead_assignee_user_id ?? null;
  const assigneeName = assignedUserId ? (await loadProfileNames([assignedUserId])).get(assignedUserId) ?? "Team member" : null;
  return { id: String(row.lead_id), assignedUserId, assigneeName };
}

/** Owner only: every known ad with its rule and how many of its leads are unassigned, plus who can be picked. */
export async function listAdAssignments(access: CrmAccessGranted): Promise<AdAssignmentOverview> {
  assertOwner(access);
  const [rules, members] = await Promise.all([
    getSupabaseAdminClient().rpc("list_lead_ad_assignments", { p_tenant_id: access.tenantId }),
    listAssignableMembers(access.tenantId),
  ]);
  if (rules.error) throw new AppError("Ad assignments could not be loaded.", { status: 500, code: "AD_ASSIGNMENTS_LOAD_FAILED", retryable: true });
  const ads = ((rules.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    adId: String(row.ad_id),
    adName: typeof row.ad_name === "string" && row.ad_name.trim() ? row.ad_name : null,
    assigneeUserId: typeof row.assignee_user_id === "string" ? row.assignee_user_id : null,
    totalLeads: Number(row.total_leads ?? 0),
    unassignedLeads: Number(row.unassigned_leads ?? 0),
  }));
  return { ads, members };
}

/** Owner only: sets (or, with null, clears) the one person who receives new leads from this ad. */
export async function setAdAssignmentRule(access: CrmAccessGranted, adId: string, assigneeUserId: string | null): Promise<void> {
  assertOwner(access);
  const { data, error } = await getSupabaseAdminClient().rpc("set_lead_ad_assignment_rule", {
    p_tenant_id: access.tenantId, p_owner_user_id: access.userId, p_ad_id: adId, p_assignee_user_id: assigneeUserId,
  });
  if (error) {
    if (error.code === "42501") throw new AppError(OWNER_ONLY, { status: 403, code: "AD_ASSIGNMENT_NOT_ALLOWED" });
    throw new AppError("The ad assignment could not be saved.", { status: 500, code: "AD_ASSIGNMENT_FAILED", retryable: true });
  }
  if (data === "AD_NOT_FOUND") throw new AppError("This ad was not found for your company.", { status: 404, code: "AD_NOT_FOUND" });
  if (data === "INVALID_ASSIGNEE") throw new AppError("Choose an active member of this company.", { status: 400, code: "INVALID_ASSIGNEE" });
  if (data !== "UPDATED" && data !== "CLEARED") throw new AppError("The ad assignment could not be saved.", { status: 500, code: "AD_ASSIGNMENT_FAILED" });
}

/** Owner only: gives the ad's assignee every lead of that ad that is still unassigned. Returns how many changed. */
export async function applyAdAssignmentRule(access: CrmAccessGranted, adId: string): Promise<{ assigned: number }> {
  assertOwner(access);
  const { data, error } = await getSupabaseAdminClient().rpc("apply_lead_ad_assignment_rule", {
    p_tenant_id: access.tenantId, p_owner_user_id: access.userId, p_ad_id: adId,
  });
  if (error) {
    if (error.code === "42501") throw new AppError(OWNER_ONLY, { status: 403, code: "AD_ASSIGNMENT_NOT_ALLOWED" });
    if (error.code === "P0002") throw new AppError("Choose who receives this ad's leads first.", { status: 409, code: "AD_RULE_NOT_FOUND" });
    if (error.code === "22023") throw new AppError("The person assigned to this ad is no longer active. Choose someone else.", { status: 409, code: "INVALID_ASSIGNEE" });
    throw new AppError("The unassigned leads could not be assigned.", { status: 500, code: "AD_ASSIGNMENT_APPLY_FAILED", retryable: true });
  }
  return { assigned: typeof data === "number" ? data : 0 };
}

function assertOwner(access: CrmAccessGranted): void {
  if (access.membershipRole !== "owner") throw new AppError(OWNER_ONLY, { status: 403, code: "AD_ASSIGNMENT_NOT_ALLOWED" });
}

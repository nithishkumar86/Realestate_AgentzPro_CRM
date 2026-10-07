import "server-only";

import type { CrmAccessGranted } from "@/lib/server/auth/access";
import { AppError } from "@/lib/server/app-error";
import { listAssignableMembers, type AssignableMember } from "@/lib/server/lead-assignment-service";
import { getTenantTimezone } from "@/lib/server/lead-query-service";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const TASK_BUCKETS = ["overdue", "today", "upcoming", "done"] as const;
export type TaskBucket = typeof TASK_BUCKETS[number];
export const DONE_RANGES = ["7d", "30d", "all"] as const;
export type DoneRange = typeof DONE_RANGES[number];

export interface TrackedTask {
  id: string; leadId: string; title: string; dueAt: string; originalDueAt: string; repeatRule: string;
  status: string; closedAt: string | null; leadName: string | null; leadPhone: string | null;
  ownerUserId: string | null; ownerName: string | null;
  /** Done tab only: closed no later than the ORIGINAL due time. */
  onTime: boolean | null;
  /** The due time was moved at least once. */
  rescheduled: boolean;
  /** What the lead drawer needs to open straight from a row. */
  lead: { status: string; facebookPage: string; adName: string; email: string | null; assignedUserId: string | null };
}
export interface TaskCounts { overdue: number; today: number; upcoming: number; done: number; doneOnTime: number; }
export interface TaskOverview {
  items: TrackedTask[]; counts: TaskCounts; timezone: string;
  isOwner: boolean; members: AssignableMember[]; page: number; pageSize: number;
}
export interface TaskOverviewRequest { bucket: TaskBucket; member?: string; range?: DoneRange; page?: number; }

const PAGE_SIZE = 50;

/**
 * The Tasks page. Employees only ever see the tasks they own (the assignee of the lead, else the creator);
 * the company owner sees everyone's and may narrow to one member. Both scopes are decided here from the
 * verified session, never from the request.
 */
export async function getTaskOverview(access: CrmAccessGranted, request: TaskOverviewRequest): Promise<TaskOverview> {
  const isOwner = access.membershipRole === "owner";
  const ownerFilter = isOwner ? request.member ?? null : access.userId;
  const timezone = await getTenantTimezone(access.tenantId);
  const range = request.range ?? "7d";
  const from = range === "all" ? null : new Date(Date.now() - (range === "7d" ? 7 : 30) * 86_400_000).toISOString();
  const page = Math.max(1, request.page ?? 1);
  const db = getSupabaseAdminClient();

  const [list, counts, members] = await Promise.all([
    db.rpc("list_tracked_tasks", {
      p_tenant_id: access.tenantId, p_bucket: request.bucket, p_owner_user_id: ownerFilter,
      p_from: from, p_to: null, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE,
    }),
    db.rpc("count_tracked_tasks", { p_tenant_id: access.tenantId, p_owner_user_id: ownerFilter, p_from: from, p_to: null }),
    isOwner ? listAssignableMembers(access.tenantId) : Promise.resolve([] as AssignableMember[]),
  ]);
  if (list.error || counts.error) throw new AppError("Tasks could not be loaded.", { status: 500, code: "TASKS_QUERY_FAILED" });

  const items = ((list.data ?? []) as Record<string, unknown>[]).map(toTrackedTask);
  await attachLeadContext(access.tenantId, items);
  const countRow = ((Array.isArray(counts.data) ? counts.data[0] : counts.data) ?? {}) as Record<string, unknown>;
  return {
    items,
    counts: {
      overdue: Number(countRow.overdue ?? 0), today: Number(countRow.today ?? 0), upcoming: Number(countRow.upcoming ?? 0),
      done: Number(countRow.done ?? 0), doneOnTime: Number(countRow.done_on_time ?? 0),
    },
    timezone, isOwner, members, page, pageSize: PAGE_SIZE,
  };
}

function toTrackedTask(row: Record<string, unknown>): TrackedTask {
  const dueAt = String(row.due_at);
  const originalDueAt = String(row.original_due_at);
  const closedAt = row.closed_at ? String(row.closed_at) : null;
  return {
    id: String(row.id), leadId: String(row.lead_id), title: String(row.title), dueAt, originalDueAt,
    repeatRule: String(row.repeat_rule), status: String(row.status), closedAt,
    leadName: row.lead_name ? String(row.lead_name) : null, leadPhone: row.lead_phone ? String(row.lead_phone) : null,
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null, ownerName: row.owner_name ? String(row.owner_name) : null,
    onTime: closedAt ? new Date(closedAt).getTime() <= new Date(originalDueAt).getTime() : null,
    rescheduled: new Date(dueAt).getTime() !== new Date(originalDueAt).getTime(),
    lead: { status: "New Lead", facebookPage: "", adName: "", email: null, assignedUserId: null },
  };
}

/** One tenant-scoped query for the page's leads, so a row can open the lead drawer without another round trip. */
async function attachLeadContext(tenantId: string, items: TrackedTask[]): Promise<void> {
  if (items.length === 0) return;
  const { data, error } = await getSupabaseAdminClient().from("lead_data")
    .select("id,status,ad_name,lead_email,assigned_user_id,facebook_pages!lead_data_facebook_page_record_id_fkey(facebook_page_name)")
    .eq("tenant_id", tenantId)
    .in("id", [...new Set(items.map((item) => item.leadId))]);
  if (error) throw new AppError("Tasks could not be loaded.", { status: 500, code: "TASKS_QUERY_FAILED" });
  const byId = new Map((data ?? []).map((row) => [String(row.id), row as Record<string, unknown>]));
  for (const item of items) {
    const row = byId.get(item.leadId);
    if (!row) continue;
    const page = row.facebook_pages as { facebook_page_name?: string } | { facebook_page_name?: string }[] | null;
    const pageName = (Array.isArray(page) ? page[0] : page)?.facebook_page_name;
    item.lead = {
      status: String(row.status), facebookPage: pageName ? String(pageName) : "", adName: row.ad_name ? String(row.ad_name) : "",
      email: row.lead_email ? String(row.lead_email) : null, assignedUserId: row.assigned_user_id ? String(row.assigned_user_id) : null,
    };
  }
}

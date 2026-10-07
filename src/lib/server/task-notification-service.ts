import "server-only";

import { AppError } from "@/lib/server/app-error";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import type { TenantRequestContext } from "@/lib/server/tenant-context";

export interface TaskNotification {
  id: string; kind: "due_soon" | "due_now"; dueAt: string; createdAt: string; read: boolean;
  leadId: string; taskTitle: string; leadName: string | null;
}
const LIMIT = 30;

/** The signed-in member's own alerts, newest first. Always filtered by tenant AND user from the session. */
export async function listTaskNotifications(context: TenantRequestContext, onlyId?: string): Promise<{ items: TaskNotification[]; unread: number }> {
  const db = getSupabaseAdminClient();
  let query = db.from("task_notifications")
    .select("id,kind,due_at,created_at,read_at,lead_id,task_id")
    .eq("tenant_id", context.tenantId).eq("user_id", context.userId);
  if (onlyId) query = query.eq("id", onlyId);
  const [rows, unread] = await Promise.all([
    query.order("created_at", { ascending: false }).limit(LIMIT),
    db.from("task_notifications").select("id", { count: "exact", head: true })
      .eq("tenant_id", context.tenantId).eq("user_id", context.userId).is("read_at", null),
  ]);
  if (rows.error || unread.error) throw new AppError("Notifications could not be loaded.", { status: 500, code: "NOTIFICATIONS_QUERY_FAILED" });
  const data = (rows.data ?? []) as Record<string, unknown>[];
  if (data.length === 0) return { items: [], unread: unread.count ?? 0 };

  const [tasks, leads] = await Promise.all([
    db.from("lead_tasks").select("id,title").eq("tenant_id", context.tenantId).in("id", [...new Set(data.map((row) => String(row.task_id)))]),
    db.from("lead_data").select("id,lead_name").eq("tenant_id", context.tenantId).in("id", [...new Set(data.map((row) => String(row.lead_id)))]),
  ]);
  if (tasks.error || leads.error) throw new AppError("Notifications could not be loaded.", { status: 500, code: "NOTIFICATIONS_QUERY_FAILED" });
  const titles = new Map((tasks.data ?? []).map((row) => [String(row.id), String(row.title)]));
  const names = new Map((leads.data ?? []).map((row) => [String(row.id), row.lead_name ? String(row.lead_name) : null]));
  return {
    unread: unread.count ?? 0,
    items: data.map((row) => ({
      id: String(row.id), kind: row.kind === "due_now" ? "due_now" : "due_soon", dueAt: String(row.due_at), createdAt: String(row.created_at),
      read: row.read_at !== null, leadId: String(row.lead_id), taskTitle: titles.get(String(row.task_id)) ?? "Task", leadName: names.get(String(row.lead_id)) ?? null,
    })),
  };
}

/** Marks the member's own alerts read: the given ids, or all of them. Another member's ids simply match nothing. */
export async function markTaskNotificationsRead(context: TenantRequestContext, ids: string[] | "all"): Promise<void> {
  let query = getSupabaseAdminClient().from("task_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("tenant_id", context.tenantId).eq("user_id", context.userId).is("read_at", null);
  if (ids !== "all") query = query.in("id", ids);
  const { error } = await query;
  if (error) throw new AppError("Notifications could not be updated.", { status: 500, code: "NOTIFICATIONS_UPDATE_FAILED" });
}

import "server-only";

import { AppError } from "@/lib/server/app-error";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import type { TenantRequestContext } from "@/lib/server/tenant-context";
import { TIMELINE_FILTER_TYPES, type LeadActivityType, type TimelineFilter } from "@/features/leads/lead-options";

/**
 * Lead Timeline, notes and follow-up tasks (migration 20261005120000_lead_notes_tasks_timeline.sql).
 *
 * Timeline rows are written only by database triggers; this module only reads them. Notes and tasks are
 * written here as service_role, always pinned to the tenant from the verified session, with the actor taken
 * from that session — never from the request. Task changes go through the reschedule_lead_task /
 * close_lead_task RPCs, which re-check that the actor is an active member of the tenant.
 */

export interface LeadActivityItem {
  id: string;
  type: LeadActivityType;
  summary: string;
  metadata: Record<string, unknown>;
  actorName: string;
  createdAt: string;
  /** Full note text for note_added rows (the summary is cut at 120 characters). */
  noteBody?: string;
  /** True for the lead_created rows added when the timeline launched; earlier history was never recorded. */
  backfilled: boolean;
}

export interface LeadActivityPage { items: LeadActivityItem[]; nextCursor: string | null; }

export type LeadTaskStatus = "open" | "completed" | "cancelled";

export interface LeadTask {
  id: string;
  title: string;
  description: string | null;
  startDate: string;
  dueDate: string;
  status: LeadTaskStatus;
  closedAt: string | null;
  createdAt: string;
}

export interface NewLeadTask { title: string; description: string | null; startDate: string; dueDate: string; }

export const TIMELINE_PAGE_SIZE = 20;
export const SYSTEM_ACTOR_NAME = "System";
export const FORMER_MEMBER_NAME = "Former team member";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The exact shape PostgREST returns for timestamptz (microsecond precision, explicit offset).
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

const TASK_COLUMNS = "id,title,description,start_date,due_date,status,closed_at,created_at";

/**
 * The cursor carries created_at exactly as the database returned it. It must never pass through a JS Date:
 * that keeps only milliseconds, so rows within the same millisecond would be skipped or repeated.
 */
export function encodeActivityCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

/** Decodes and strictly validates a cursor, so nothing user-supplied can reach the PostgREST filter syntax. */
export function decodeActivityCursor(cursor: string): { createdAt: string; id: string } {
  const invalid = () => new AppError("The timeline position is invalid. Reload the timeline.", { status: 400, code: "INVALID_CURSOR" });
  if (!CURSOR_PATTERN.test(cursor)) throw invalid();
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (parts.length !== 2) throw invalid();
  const [createdAt, id] = parts;
  if (!TIMESTAMP_PATTERN.test(createdAt) || !UUID_PATTERN.test(id)) throw invalid();
  return { createdAt, id };
}

export async function listLeadActivities(
  context: TenantRequestContext,
  leadId: string,
  options: { filter?: TimelineFilter; cursor?: string; limit?: number } = {},
): Promise<LeadActivityPage> {
  const position = options.cursor ? decodeActivityCursor(options.cursor) : null;
  const limit = Math.min(50, Math.max(1, options.limit ?? TIMELINE_PAGE_SIZE));
  await assertLeadInTenant(context, leadId);

  const db = getSupabaseAdminClient();
  let query = db.from("lead_activities")
    .select("id,type,summary,metadata,created_by,created_at")
    .eq("tenant_id", context.tenantId)
    .eq("lead_id", leadId);
  const filter = options.filter ?? "all";
  if (filter !== "all") query = query.in("type", [...TIMELINE_FILTER_TYPES[filter]]);
  // Values are validated above and quoted, so they are data to PostgREST, never filter syntax.
  if (position) query = query.or(`created_at.lt."${position.createdAt}",and(created_at.eq."${position.createdAt}",id.lt.${position.id})`);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (error) throw new AppError("The timeline could not be loaded.", { status: 500, code: "TIMELINE_QUERY_FAILED" });

  const rows = (data ?? []) as Array<{ id: string; type: LeadActivityType; summary: string; metadata: Record<string, unknown> | null; created_by: string | null; created_at: string }>;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? encodeActivityCursor(last.created_at, last.id) : null;

  const actorIds = [...new Set(page.map((row) => row.created_by).filter((id): id is string => Boolean(id)))];
  const noteIds = [...new Set(page.filter((row) => row.type === "note_added").map((row) => row.metadata?.note_id).filter((id): id is string => typeof id === "string"))];
  const [names, notes] = await Promise.all([loadActorNames(actorIds), loadNoteBodies(context, leadId, noteIds)]);

  return {
    nextCursor,
    items: page.map((row) => {
      const metadata = row.metadata ?? {};
      const noteBody = row.type === "note_added" && typeof metadata.note_id === "string" ? notes.get(metadata.note_id) : undefined;
      return {
        id: row.id,
        type: row.type,
        summary: row.summary,
        metadata,
        actorName: row.created_by ? names.get(row.created_by) ?? FORMER_MEMBER_NAME : SYSTEM_ACTOR_NAME,
        createdAt: row.created_at,
        backfilled: metadata.backfilled === true,
        ...(noteBody !== undefined ? { noteBody } : {}),
      };
    }),
  };
}

export async function addLeadNote(context: TenantRequestContext, leadId: string, body: string): Promise<{ id: string; createdAt: string }> {
  const { data, error } = await getSupabaseAdminClient().from("lead_notes")
    .insert({ tenant_id: context.tenantId, lead_id: leadId, body, created_by: context.userId })
    .select("id,created_at")
    .single();
  if (error) {
    // The composite FK (tenant_id, lead_id) rejects a lead that is not this tenant's.
    if (error.code === "23503") throw leadNotFound();
    if (error.code === "23514") throw new AppError("A note must be between 1 and 2000 characters.", { status: 400, code: "INVALID_NOTE" });
    throw new AppError("The note could not be saved.", { status: 500, code: "NOTE_SAVE_FAILED" });
  }
  return { id: String(data.id), createdAt: String(data.created_at) };
}

export async function getOpenLeadTask(context: TenantRequestContext, leadId: string): Promise<LeadTask | null> {
  await assertLeadInTenant(context, leadId);
  const { data, error } = await getSupabaseAdminClient().from("lead_tasks")
    .select(TASK_COLUMNS)
    .eq("tenant_id", context.tenantId)
    .eq("lead_id", leadId)
    .eq("status", "open")
    .maybeSingle();
  if (error) throw new AppError("The task could not be loaded.", { status: 500, code: "TASK_QUERY_FAILED" });
  return data ? toLeadTask(data) : null;
}

export async function createLeadTask(context: TenantRequestContext, leadId: string, input: NewLeadTask): Promise<LeadTask> {
  const { data, error } = await getSupabaseAdminClient().from("lead_tasks")
    .insert({
      tenant_id: context.tenantId,
      lead_id: leadId,
      title: input.title,
      description: input.description,
      start_date: input.startDate,
      due_date: input.dueDate,
      created_by: context.userId,
    })
    .select(TASK_COLUMNS)
    .single();
  if (error) {
    if (error.code === "23505") throw new AppError("This lead already has an open task. Complete or cancel it before adding a new one.", { status: 409, code: "OPEN_TASK_EXISTS" });
    if (error.code === "23503") throw leadNotFound();
    if (error.code === "23514") throw new AppError("The due date must be on or after the start date.", { status: 400, code: "INVALID_TASK_DATES" });
    throw new AppError("The task could not be saved.", { status: 500, code: "TASK_SAVE_FAILED" });
  }
  return toLeadTask(data);
}

export async function rescheduleLeadTask(context: TenantRequestContext, leadId: string, taskId: string, dueDate: string): Promise<LeadTask> {
  const { data, error } = await getSupabaseAdminClient().rpc("reschedule_lead_task", {
    p_tenant_id: context.tenantId, p_lead_id: leadId, p_task_id: taskId, p_due_date: dueDate, p_actor_user_id: context.userId,
  });
  return taskRpcResult(data, error, "The task could not be rescheduled.");
}

export async function closeLeadTask(context: TenantRequestContext, leadId: string, taskId: string, outcome: "completed" | "cancelled"): Promise<LeadTask> {
  const { data, error } = await getSupabaseAdminClient().rpc("close_lead_task", {
    p_tenant_id: context.tenantId, p_lead_id: leadId, p_task_id: taskId, p_outcome: outcome, p_actor_user_id: context.userId,
  });
  return taskRpcResult(data, error, outcome === "completed" ? "The task could not be completed." : "The task could not be cancelled.");
}

function taskRpcResult(data: unknown, error: { code?: string } | null, failure: string): LeadTask {
  if (error) {
    if (error.code === "55000") throw new AppError("This task is already closed and can no longer be changed.", { status: 409, code: "TASK_ALREADY_CLOSED" });
    if (error.code === "23514") throw new AppError("The due date must be on or after the start date.", { status: 400, code: "INVALID_TASK_DATES" });
    if (error.code === "42501") throw new AppError("You are not allowed to change tasks for this company.", { status: 403, code: "TASK_UPDATE_FORBIDDEN" });
    if (error.code === "22023") throw new AppError("Request data is invalid.", { status: 400, code: "INVALID_REQUEST" });
    throw new AppError(failure, { status: 500, code: "TASK_UPDATE_FAILED" });
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new AppError("Task not found for this lead.", { status: 404, code: "TASK_NOT_FOUND" });
  return toLeadTask(row as Record<string, unknown>);
}

async function assertLeadInTenant(context: TenantRequestContext, leadId: string): Promise<void> {
  const { data, error } = await getSupabaseAdminClient().from("lead_data")
    .select("id")
    .eq("tenant_id", context.tenantId)
    .eq("id", leadId)
    .maybeSingle();
  if (error) throw new AppError("The lead could not be loaded.", { status: 500, code: "LEAD_QUERY_FAILED" });
  if (!data) throw leadNotFound();
}

async function loadActorNames(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const { data, error } = await getSupabaseAdminClient().from("profiles").select("user_id,full_name").in("user_id", userIds);
  if (error) throw new AppError("The timeline could not be loaded.", { status: 500, code: "TIMELINE_QUERY_FAILED" });
  return new Map((data ?? []).map((row) => [String(row.user_id), String(row.full_name)]));
}

async function loadNoteBodies(context: TenantRequestContext, leadId: string, noteIds: string[]): Promise<Map<string, string>> {
  if (noteIds.length === 0) return new Map();
  const { data, error } = await getSupabaseAdminClient().from("lead_notes")
    .select("id,body")
    .eq("tenant_id", context.tenantId)
    .eq("lead_id", leadId)
    .in("id", noteIds);
  if (error) throw new AppError("The timeline could not be loaded.", { status: 500, code: "TIMELINE_QUERY_FAILED" });
  return new Map((data ?? []).map((row) => [String(row.id), String(row.body)]));
}

function toLeadTask(row: Record<string, unknown>): LeadTask {
  return {
    id: String(row.id),
    title: String(row.title),
    description: typeof row.description === "string" ? row.description : null,
    startDate: String(row.start_date),
    dueDate: String(row.due_date),
    status: row.status as LeadTaskStatus,
    closedAt: typeof row.closed_at === "string" ? row.closed_at : null,
    createdAt: String(row.created_at),
  };
}

function leadNotFound(): AppError {
  return new AppError("Lead not found for this tenant.", { status: 404, code: "LEAD_NOT_FOUND" });
}

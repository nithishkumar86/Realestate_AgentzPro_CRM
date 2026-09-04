import "server-only";

import { AppError } from "@/lib/server/app-error";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import type { TenantRequestContext } from "@/lib/server/tenant-context";
import type { LeadLabel, LeadStatus } from "@/features/leads/lead-options";

export type LeadSortField = "leadName" | "leadDate";
export type QuickFilter = "all" | "today" | "month";
export interface LeadSearchRequest {
  search?: string;
  quickFilter?: QuickFilter;
  dateFrom?: string;
  dateTo?: string;
  projectId?: string | "unassigned";
  status?: LeadStatus;
  label?: LeadLabel;
  page?: number;
  pageSize?: number;
  sortField?: LeadSortField;
  sortDirection?: "asc" | "desc";
}
export interface LeadRow {
  id: string; leadName: string | null; email: string | null; phone: string | null;
  project: string | null; facebookPage: string; adName: string; leadDate: string;
  status: LeadStatus; label: LeadLabel;
}
export interface PaginatedLeadRows { items: LeadRow[]; total: number; page: number; pageSize: number; totalPages: number; timezone: string; }

export async function queryLeads(context: TenantRequestContext, request: LeadSearchRequest, exportAll = false): Promise<PaginatedLeadRows> {
  const timezone = await getTenantTimezone(context.tenantId);
  const page = Math.max(1, request.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, request.pageSize ?? 25));
  const sortField = request.sortField ?? "leadDate";
  const ascending = (request.sortDirection ?? "desc") === "asc";
  let query = getSupabaseAdminClient().from("lead_data")
    .select("id,lead_name,lead_email,lead_phone,ad_id,ad_name_snapshot,lead_created_time,project_id,status,label,facebook_pages!lead_data_facebook_page_record_id_fkey(facebook_page_name),projects!lead_data_tenant_project_fk(project_name)", { count: "exact" })
    .eq("tenant_id", context.tenantId);
  if (request.projectId === "unassigned") query = query.is("project_id", null);
  else if (request.projectId) query = query.eq("project_id", request.projectId);
  if (request.status) query = query.eq("status", request.status);
  if (request.label) query = query.eq("label", request.label);
  if (request.search?.trim()) {
    const raw = request.search.trim().replace(/[,%()]/g, " ");
    const digits = normalizeIndianPhone(raw);
    const predicates = [`lead_name.ilike.%${raw}%`, `lead_email.ilike.%${raw}%`, `lead_phone.ilike.%${raw}%`];
    if (digits) predicates.push(`lead_phone_normalized.eq.${digits}`);
    query = query.or(predicates.join(","));
  }
  const range = resolveDateRange(request, timezone);
  if (range) query = query.gte("lead_created_time", range.from).lt("lead_created_time", range.to);
  query = query.order(sortField === "leadName" ? "lead_name" : "lead_created_time", { ascending, nullsFirst: false }).order("id", { ascending });
  if (!exportAll) query = query.range((page - 1) * pageSize, page * pageSize - 1);
  const { data, error, count } = await query;
  if (error) throw new AppError("Leads could not be loaded.", { status: 500, code: "LEAD_QUERY_FAILED" });
  const items = (data ?? []).map((lead) => toLeadRow(lead as Record<string, unknown>));
  const total = exportAll ? items.length : count ?? 0;
  return { items, total, page: exportAll ? 1 : page, pageSize: exportAll ? items.length : pageSize, totalPages: exportAll ? 1 : Math.max(1, Math.ceil(total / pageSize)), timezone };
}

function toLeadRow(lead: Record<string, unknown>): LeadRow {
  const page = lead.facebook_pages as { facebook_page_name?: string } | null;
  const project = lead.projects as { project_name?: string } | null;
  const adId = typeof lead.ad_id === "string" ? lead.ad_id : null;
  const snapshot = typeof lead.ad_name_snapshot === "string" && lead.ad_name_snapshot.trim() ? lead.ad_name_snapshot : null;
  return { id: String(lead.id), leadName: asNullableString(lead.lead_name), email: asNullableString(lead.lead_email), phone: asNullableString(lead.lead_phone), project: project?.project_name ?? null, facebookPage: page?.facebook_page_name ?? "Unknown Page", adName: snapshot ?? (adId ? `Advertisement ••••${adId.slice(-4)} — name unavailable` : "Organic / Unattributed"), leadDate: String(lead.lead_created_time), status: lead.status as LeadStatus, label: lead.label as LeadLabel };
}

/**
 * Updates a single lead's triage status or label. This is the only writer for
 * these columns — it must never be reachable from the leads-list filter UI,
 * which only ever reads status/label to narrow the query above.
 */
export async function updateLeadTriage(context: TenantRequestContext, leadId: string, update: { status: LeadStatus } | { label: LeadLabel }): Promise<{ id: string; status: LeadStatus; label: LeadLabel }> {
  const patch = "status" in update ? { status: update.status } : { label: update.label };
  const { data, error } = await getSupabaseAdminClient().from("lead_data")
    .update(patch)
    .eq("tenant_id", context.tenantId)
    .eq("id", leadId)
    .select("id,status,label")
    .maybeSingle();
  if (error) throw new AppError("The lead could not be updated.", { status: 500, code: "LEAD_UPDATE_FAILED" });
  if (!data) throw new AppError("Lead not found for this tenant.", { status: 404, code: "LEAD_NOT_FOUND" });
  return { id: String(data.id), status: data.status as LeadStatus, label: data.label as LeadLabel };
}
function asNullableString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }

async function getTenantTimezone(tenantId: string): Promise<string> {
  const { data, error } = await getSupabaseAdminClient().from("tenants").select("timezone").eq("tenant_id", tenantId).single();
  if (error || !data || typeof data.timezone !== "string" || data.timezone === "UTC") throw new AppError("A verified tenant timezone is required before lead date filtering.", { status: 503, code: "TENANT_TIMEZONE_UNAVAILABLE" });
  return data.timezone;
}
function resolveDateRange(request: LeadSearchRequest, timezone: string): { from: string; to: string } | null {
  let from = request.dateFrom; let to = request.dateTo;
  if (request.quickFilter === "today") from = to = localDate(new Date(), timezone);
  if (request.quickFilter === "month") { const today = localDate(new Date(), timezone); from = `${today.slice(0, 7)}-01`; to = today; }
  if (!from && !to) return null;
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new AppError("Select a valid inclusive date range.", { status: 400, code: "INVALID_DATE_RANGE" });
  return { from: zonedMidnight(from, timezone).toISOString(), to: zonedMidnight(addDays(to, 1), timezone).toISOString() };
}
function localDate(date: Date, timezone: string): string { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }
function addDays(date: string, days: number): string { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function zonedMidnight(date: string, timezone: string): Date { let instant = new Date(`${date}T00:00:00.000Z`); for (let i = 0; i < 2; i += 1) { const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(instant); const item = (type: string) => Number(parts.find((part) => part.type === type)?.value); const rendered = Date.UTC(item("year"), item("month") - 1, item("day"), item("hour"), item("minute")); instant = new Date(instant.getTime() - (rendered - Date.parse(`${date}T00:00:00.000Z`))); } return instant; }
export function normalizeIndianPhone(value: string): string | null { const digits = value.replace(/\D/g, ""); if (!digits) return null; if (/^91\d{10}$/.test(digits)) return digits; if (/^0\d{10}$/.test(digits)) return `91${digits.slice(1)}`; if (/^\d{10}$/.test(digits)) return `91${digits}`; return digits; }

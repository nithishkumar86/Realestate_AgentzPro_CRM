import "server-only";

import { AppError } from "@/lib/server/app-error";
import {
  getTenantTimezone,
  localDate,
  normalizeIndianPhone,
  resolveDateRange,
  zonedMidnight,
  type LeadSearchRequest,
} from "@/lib/server/lead-query-service";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import type { TenantRequestContext } from "@/lib/server/tenant-context";

/** The /leads filters the dashboard honours. Paging, sorting and bulk actions do not apply. */
export type DashboardStatsRequest = Pick<
  LeadSearchRequest,
  "search" | "quickFilter" | "dateFrom" | "dateTo" | "pageRecordId" | "adId" | "status" | "label"
>;

export type TimelineGranularity = "hour" | "day" | "month";

export interface DashboardStats {
  tenantId: string;
  timezone: string;
  granularity: TimelineGranularity;
  total: number;
  monthToDate: number;
  previousMonthSamePeriod: number;
  byPage: Array<{ pageRecordId: string; pageName: string; count: number }>;
  byLabel: Array<{ label: string; count: number }>;
  byStatus: Array<{ status: string; count: number }>;
  topAds: Array<{ adId: string; name: string | null; count: number }>;
  /** `bucket` is a tenant-local wall-clock time (YYYY-MM-DDTHH:MM:SS) with no offset. */
  timeline: Array<{ bucket: string; count: number }>;
  timelineTruncated: boolean;
  generatedAt: string;
}

type StatsPayload = Omit<DashboardStats, "tenantId" | "timezone" | "granularity">;

const DAY_MS = 86_400_000;
const HOUR_BUCKET_MAX_WINDOW_MS = DAY_MS + 3_600_000; // one local day, tolerating a 25h DST day
const DAY_BUCKET_MAX_WINDOW_MS = 62 * DAY_MS;

export interface DashboardRpcArgs {
  p_tenant_id: string;
  p_from: string | null;
  p_to: string | null;
  p_month_from: string;
  p_month_to: string;
  p_prev_month_from: string;
  p_prev_month_to: string;
  p_page_record_id: string | null;
  p_ad_id: string | null;
  p_status: string | null;
  p_label: string | null;
  p_search: string | null;
  p_search_digits: string | null;
  p_tz: string;
  p_granularity: TimelineGranularity;
}

/**
 * Turns the filter request into the RPC arguments. Pure so the boundary maths (tenant-local month,
 * "same period last month", bucket size) is unit-testable without a database. Date resolution and
 * search normalisation reuse the /leads implementations so both pages agree on every input.
 */
export function buildDashboardRpcArgs(
  tenantId: string,
  timezone: string,
  request: DashboardStatsRequest,
  now: Date = new Date(),
): DashboardRpcArgs {
  const range = resolveDateRange(request, timezone);

  const today = localDate(now, timezone);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)); // 1-12
  const monthStart = zonedMidnight(`${today.slice(0, 7)}-01`, timezone);
  const nextMonthStart = zonedMidnight(monthKey(year, month + 1), timezone);
  const prevMonthStart = zonedMidnight(monthKey(year, month - 1), timezone);
  // Same elapsed time into last month, never running past the start of this month.
  const prevSamePeriodEnd = new Date(Math.min(prevMonthStart.getTime() + (now.getTime() - monthStart.getTime()), monthStart.getTime()));

  // queryLeads replaces these characters with spaces before building its ilike patterns.
  const trimmed = request.search?.trim() ?? "";
  const search = trimmed ? trimmed.replace(/[,%()]/g, " ") : null;

  return {
    p_tenant_id: tenantId,
    p_from: range?.from ?? null,
    p_to: range?.to ?? null,
    p_month_from: monthStart.toISOString(),
    p_month_to: nextMonthStart.toISOString(),
    p_prev_month_from: prevMonthStart.toISOString(),
    p_prev_month_to: prevSamePeriodEnd.toISOString(),
    p_page_record_id: request.pageRecordId ?? null,
    p_ad_id: request.adId ?? null,
    p_status: request.status ?? null,
    p_label: request.label ?? null,
    p_search: search,
    p_search_digits: search ? normalizeIndianPhone(search) : null,
    p_tz: timezone,
    p_granularity: chooseGranularity(range),
  };
}

function monthKey(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month - 1, 1)); // Date.UTC rolls month 0 / 13 into the neighbouring year
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function chooseGranularity(range: { from: string; to: string } | null): TimelineGranularity {
  if (!range) return "month";
  const windowMs = Date.parse(range.to) - Date.parse(range.from);
  if (windowMs <= HOUR_BUCKET_MAX_WINDOW_MS) return "hour";
  if (windowMs <= DAY_BUCKET_MAX_WINDOW_MS) return "day";
  return "month";
}

export async function getDashboardStats(context: TenantRequestContext, request: DashboardStatsRequest): Promise<DashboardStats> {
  const timezone = await getTenantTimezone(context.tenantId);
  const args = buildDashboardRpcArgs(context.tenantId, timezone, request);
  const { data, error } = await getSupabaseAdminClient().rpc("get_dashboard_stats", args);
  if (error || !data || typeof data !== "object") {
    throw new AppError("The dashboard could not be loaded.", { status: 500, code: "DASHBOARD_STATS_FAILED" });
  }
  return { tenantId: context.tenantId, timezone, granularity: args.p_granularity, ...(data as StatsPayload) };
}

import "server-only";

import type { DashboardPlatformId } from "@/features/dashboard/dashboard-platforms";
import { AppError } from "@/lib/server/app-error";
import {
  getTenantTimezone,
  localDate,
  resolveDateRange,
  zonedMidnight,
  type LeadSearchRequest,
} from "@/lib/server/lead-query-service";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import type { TenantRequestContext } from "@/lib/server/tenant-context";

/**
 * The platform the dashboard shows plus the /leads filters it honours. Paging, sorting and bulk actions do not
 * apply. Page and Ad only reach here for a platform that offers them (the route rejects them otherwise).
 */
export type DashboardStatsRequest = Pick<
  LeadSearchRequest,
  "quickFilter" | "dateFrom" | "dateTo" | "pageRecordId" | "adId" | "status" | "label"
> & { platform: DashboardPlatformId };

export type TimelineGranularity = "hour" | "day" | "month";

export interface DashboardStats {
  tenantId: string;
  /** The platform these numbers are for; the page drops a response for a platform it no longer shows. */
  platform: DashboardPlatformId;
  timezone: string;
  granularity: TimelineGranularity;
  total: number;
  monthToDate: number;
  previousMonthSamePeriod: number;
  /** The platform's grouping (Facebook Page, Google Ads campaign); empty for a platform without one. `id` is null for "Unattributed". */
  byGroup: Array<{ id: string | null; name: string; count: number }>;
  byLabel: Array<{ label: string; count: number }>;
  byStatus: Array<{ status: string; count: number }>;
  /** Ranked items (Meta ad, Google ad group) plus the "other" / "unattributed" catch-all rows; empty for a platform without items. */
  topItems: Array<{ id: string; name: string | null; count: number }>;
  /** `bucket` is a tenant-local wall-clock time (YYYY-MM-DDTHH:MM:SS) with no offset. */
  timeline: Array<{ bucket: string; count: number }>;
  timelineTruncated: boolean;
  generatedAt: string;
}

type StatsPayload = Omit<DashboardStats, "tenantId" | "platform" | "timezone" | "granularity">;

const DAY_MS = 86_400_000;
const HOUR_BUCKET_MAX_WINDOW_MS = DAY_MS + 3_600_000; // one local day, tolerating a 25h DST day
const DAY_BUCKET_MAX_WINDOW_MS = 62 * DAY_MS;

export interface DashboardRpcArgs {
  p_tenant_id: string;
  p_lead_source: DashboardPlatformId;
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

  return {
    p_tenant_id: tenantId,
    p_lead_source: request.platform,
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
  const { data, error } = await getSupabaseAdminClient().rpc("get_dashboard_platform_stats", args);
  if (error || !data || typeof data !== "object") {
    throw new AppError("The dashboard could not be loaded.", { status: 500, code: "DASHBOARD_STATS_FAILED" });
  }
  return { tenantId: context.tenantId, platform: request.platform, timezone, granularity: args.p_granularity, ...(data as StatsPayload) };
}

import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { DASHBOARD_PLATFORM_IDS, DEFAULT_DASHBOARD_PLATFORM, getDashboardPlatform } from "@/features/dashboard/dashboard-platforms";
import { LEAD_LABELS, LEAD_STATUSES } from "@/features/leads/lead-options";
import { getDashboardStats } from "@/lib/server/dashboard-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

export const runtime = "nodejs";

// Same filter vocabulary as /api/leads/query, minus paging and sorting, plus the platform the dashboard shows
// (missing = Facebook, the default view). .strict() also rejects any client-supplied tenant identifier: the
// tenant comes only from the verified session. Page and Ad are rejected for a platform without those filters,
// so a stale Facebook page id can never silently zero a Google Ads view.
const requestSchema = z.object({
  platform: z.enum(DASHBOARD_PLATFORM_IDS).default(DEFAULT_DASHBOARD_PLATFORM),
  quickFilter: z.enum(["all", "today", "month"]).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  pageRecordId: z.string().uuid().optional(),
  adId: z.string().min(1).max(100).or(z.literal("unattributed")).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  label: z.enum(LEAD_LABELS).optional(),
}).strict().superRefine((request, context) => {
  const { filters } = getDashboardPlatform(request.platform);
  if (request.pageRecordId && !filters.page) context.addIssue({ code: "custom", path: ["pageRecordId"], message: "The Page filter does not apply to this platform." });
  if (request.adId && !filters.ad) context.addIssue({ code: "custom", path: ["adId"], message: "The Ad filter does not apply to this platform." });
});

export async function POST(request: Request): Promise<Response> {
  try {
    const context = await resolveTenantRequestContext();
    const filters = await parseJsonBody(request, requestSchema);
    const response = createSuccessResponse(await getDashboardStats(context, filters));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

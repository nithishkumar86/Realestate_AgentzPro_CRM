import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { LEAD_LABELS, LEAD_STATUSES } from "@/features/leads/lead-options";
import { getDashboardStats } from "@/lib/server/dashboard-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

export const runtime = "nodejs";

// Same filter vocabulary as /api/leads/query, minus paging and sorting. .strict() also rejects any
// client-supplied tenant identifier: the tenant comes only from the verified session.
const requestSchema = z.object({
  quickFilter: z.enum(["all", "today", "month"]).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  pageRecordId: z.string().uuid().optional(),
  adId: z.string().min(1).max(100).or(z.literal("unattributed")).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  label: z.enum(LEAD_LABELS).optional(),
}).strict();

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

import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { ASSIGNEE_FILTER_SHORTCUTS, GOOGLE_CAMPAIGN_ID_PATTERN, LEAD_LABELS, LEAD_SOURCES, LEAD_STATUSES } from "@/features/leads/lead-options";
import { countNewLeadsOnFirstPage } from "@/lib/server/lead-query-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

/**
 * The /leads "new leads arrived" bar. The body is the request of the table's last load (the same filter, order and
 * page-size fields as /api/leads/query, without a page or a single lead) plus `since`, the cursor that load returned:
 * when the newest lead was saved, as the database wrote it (null when the company had no leads). Answers only how many
 * leads on the table's first page are newer than that; no lead data leaves the server.
 */
const requestSchema = z.object({ search: z.string().max(200).optional(), quickFilter: z.enum(["all", "today", "month"]).optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(), pageRecordId: z.string().uuid().optional(), adId: z.string().min(1).max(100).or(z.literal("unattributed")).optional(), campaignId: z.string().regex(GOOGLE_CAMPAIGN_ID_PATTERN).or(z.literal("unattributed")).optional(), status: z.enum(LEAD_STATUSES).optional(), label: z.enum(LEAD_LABELS).optional(), assignee: z.union([z.enum(ASSIGNEE_FILTER_SHORTCUTS), z.string().uuid()]).optional(), source: z.enum(LEAD_SOURCES).optional(), pageSize: z.number().int().positive().max(100), sortField: z.enum(["leadName", "leadDate"]).optional(), sortDirection: z.enum(["asc", "desc"]).optional(), since: z.iso.datetime({ offset: true }).nullable() }).strict();

export async function POST(request: Request) {
  try {
    const context = await resolveTenantRequestContext();
    const { since, pageSize, ...filters } = await parseJsonBody(request, requestSchema);
    return createSuccessResponse({ count: await countNewLeadsOnFirstPage(context, filters, since, pageSize) });
  } catch (error) { return createErrorResponse(error); }
}

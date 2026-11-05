import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { ASSIGNEE_FILTER_SHORTCUTS, GOOGLE_CAMPAIGN_ID_PATTERN, LEAD_LABELS, LEAD_SOURCES, LEAD_STATUSES } from "@/features/leads/lead-options";
import { getLeadsCursor, queryLeads } from "@/lib/server/lead-query-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const requestSchema = z.object({ search: z.string().max(200).optional(), leadId: z.string().uuid().optional(), quickFilter: z.enum(["all", "today", "month"]).optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(), pageRecordId: z.string().uuid().optional(), adId: z.string().min(1).max(100).or(z.literal("unattributed")).optional(), campaignId: z.string().regex(GOOGLE_CAMPAIGN_ID_PATTERN).or(z.literal("unattributed")).optional(), status: z.enum(LEAD_STATUSES).optional(), label: z.enum(LEAD_LABELS).optional(), assignee: z.union([z.enum(ASSIGNEE_FILTER_SHORTCUTS), z.string().uuid()]).optional(), source: z.enum(LEAD_SOURCES).optional(), page: z.number().int().positive().optional(), pageSize: z.number().int().positive().max(100).optional(), sortField: z.enum(["leadName", "leadDate"]).optional(), sortDirection: z.enum(["asc", "desc"]).optional() }).strict();

export async function POST(request: Request) {
  try {
    const context = await resolveTenantRequestContext();
    const body = await parseJsonBody(request, requestSchema);
    // The "new leads" bar's cursor: when the newest lead was saved, read BEFORE the list. A lead saved between the two
    // reads is then on screen and counted once (a "1 new lead" bar that clears on Show), never missed. Best effort: if
    // it fails the table still loads and only the bar stays off. Not needed for the single lead a task alert opens.
    const cursor = body.leadId ? undefined : await getLeadsCursor(context.tenantId).catch(() => undefined);
    const result = await queryLeads(context, body);
    return createSuccessResponse(cursor === undefined ? result : { ...result, cursor });
  } catch (error) { return createErrorResponse(error); }
}

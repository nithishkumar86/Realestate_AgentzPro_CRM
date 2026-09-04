import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { LEAD_LABELS, LEAD_STATUSES } from "@/features/leads/lead-options";
import { queryLeads } from "@/lib/server/lead-query-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const requestSchema = z.object({ search: z.string().max(200).optional(), quickFilter: z.enum(["all", "today", "month"]).optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(), projectId: z.string().uuid().or(z.literal("unassigned")).optional(), status: z.enum(LEAD_STATUSES).optional(), label: z.enum(LEAD_LABELS).optional(), page: z.number().int().positive().optional(), pageSize: z.number().int().positive().max(100).optional(), sortField: z.enum(["leadName", "leadDate"]).optional(), sortDirection: z.enum(["asc", "desc"]).optional() }).strict();

export async function POST(request: Request) {
  try { return createSuccessResponse(await queryLeads(await resolveTenantRequestContext(), await parseJsonBody(request, requestSchema))); }
  catch (error) { return createErrorResponse(error); }
}

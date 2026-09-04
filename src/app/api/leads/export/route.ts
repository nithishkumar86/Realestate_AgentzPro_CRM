import { NextResponse } from "next/server";
import { z } from "zod";
import { createErrorResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { LEAD_LABELS, LEAD_STATUSES } from "@/features/leads/lead-options";
import { queryLeads } from "@/lib/server/lead-query-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const requestSchema = z.object({ search: z.string().max(200).optional(), quickFilter: z.enum(["all", "today", "month"]).optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(), projectId: z.string().uuid().or(z.literal("unassigned")).optional(), status: z.enum(LEAD_STATUSES).optional(), label: z.enum(LEAD_LABELS).optional(), sortField: z.enum(["leadName", "leadDate"]).optional(), sortDirection: z.enum(["asc", "desc"]).optional() }).strict();
export async function POST(request: Request) {
  try {
    const result = await queryLeads(await resolveTenantRequestContext(), await parseJsonBody(request, requestSchema), true);
    const csv = ["Lead Name,Email,Phone,Project,Facebook Page,Ad Name,Status,Label,Lead Date", ...result.items.map((row) => [row.leadName, row.email, row.phone, row.project, row.facebookPage, row.adName, row.status, row.label, new Intl.DateTimeFormat("en-IN", { timeZone: result.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(row.leadDate))].map(csvValue).join(","))].join("\r\n");
    return new NextResponse(`\uFEFF${csv}`, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename=leads-${new Date().toISOString().slice(0, 10)}.csv` } });
  } catch (error) { return createErrorResponse(error); }
}
function csvValue(value: string | null): string { const safe = String(value ?? "").replace(/^[=+\-@\t\r]/, "'$&"); return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; }

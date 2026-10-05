import { z } from "zod";
import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireLeadId } from "@/app/api/leads/_lib/route-params";
import { TIMELINE_FILTERS } from "@/features/leads/lead-options";
import { AppError } from "@/lib/server/app-error";
import { listLeadActivities } from "@/lib/server/lead-timeline-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const querySchema = z.object({
  filter: z.enum(TIMELINE_FILTERS).default("all"),
  cursor: z.string().min(1).max(200).optional(),
}).strict();

// One page of a lead's timeline, newest first. The cursor is opaque and validated by the service.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const leadId = requireLeadId((await params).id);
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) throw new AppError("Request data is invalid.", { status: 400, code: "INVALID_REQUEST" });
    const context = await resolveTenantRequestContext();
    return createSuccessResponse(await listLeadActivities(context, leadId, parsed.data));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

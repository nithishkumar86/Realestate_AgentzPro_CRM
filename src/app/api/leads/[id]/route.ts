import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { LEAD_LABELS, LEAD_STATUSES } from "@/features/leads/lead-options";
import { AppError } from "@/lib/server/app-error";
import { updateLeadTriage } from "@/lib/server/lead-query-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z
  .object({ status: z.enum(LEAD_STATUSES).optional(), label: z.enum(LEAD_LABELS).optional() })
  .strict()
  .refine((value) => (value.status !== undefined) !== (value.label !== undefined), {
    message: "Provide exactly one of status or label.",
  });

// This route is the only place a lead's status/label may be written — it
// persists straight to lead_data, tenant-scoped. It must never be driven by
// the leads-list filter controls, which only read these columns.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_PATTERN.test(id)) throw new AppError("A valid lead id is required.", { status: 400, code: "INVALID_LEAD_ID" });
    const body = await parseJsonBody(request, bodySchema);
    const context = await resolveTenantRequestContext();
    const update = body.status !== undefined ? { status: body.status } : { label: body.label! };
    return createSuccessResponse(await updateLeadTriage(context, id, update));
  } catch (error) {
    return createErrorResponse(error);
  }
}

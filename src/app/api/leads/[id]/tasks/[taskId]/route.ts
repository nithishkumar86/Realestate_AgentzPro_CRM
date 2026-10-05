import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { requireLeadId, requireTaskId } from "@/app/api/leads/_lib/route-params";
import { isValidCalendarDate } from "@/lib/date-utils";
import { closeLeadTask, rescheduleLeadTask } from "@/lib/server/lead-timeline-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

// Exactly one change per request: move the due date of an open task, or close it for good.
const bodySchema = z.union([
  z.object({ dueDate: z.string().refine(isValidCalendarDate) }).strict(),
  z.object({ action: z.enum(["complete", "cancel"]) }).strict(),
]);

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  try {
    const { id, taskId } = await params;
    const leadId = requireLeadId(id);
    const validTaskId = requireTaskId(taskId);
    const body = await parseJsonBody(request, bodySchema);
    const context = await resolveTenantRequestContext();
    const task = "dueDate" in body
      ? await rescheduleLeadTask(context, leadId, validTaskId, body.dueDate)
      : await closeLeadTask(context, leadId, validTaskId, body.action === "complete" ? "completed" : "cancelled");
    return createSuccessResponse(task);
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

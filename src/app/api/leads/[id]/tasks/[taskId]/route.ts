import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { requireLeadId, requireTaskId } from "@/app/api/leads/_lib/route-params";
import { TIME_PATTERN } from "@/features/leads/task-schedule";
import { isValidCalendarDate } from "@/lib/date-utils";
import { closeLeadTask, rescheduleLeadTask } from "@/lib/server/lead-timeline-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

// Exactly one change per request: move the due time of an open task (to a future time), or close it for good.
// A browser still on the previous build sends only dueDate: the task moves to the end of that day.
const bodySchema = z.union([
  z.object({ dueDate: z.string().refine(isValidCalendarDate), dueTime: z.string().regex(TIME_PATTERN).default("23:59") }).strict(),
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
      ? await rescheduleLeadTask(context, leadId, validTaskId, { dueDate: body.dueDate, dueTime: body.dueTime })
      : await closeLeadTask(context, leadId, validTaskId, body.action === "complete" ? "completed" : "cancelled");
    return createSuccessResponse(task);
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

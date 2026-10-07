import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { requireLeadId } from "@/app/api/leads/_lib/route-params";
import { LEAD_STATUSES, TASK_DESCRIPTION_MAX_LENGTH, TASK_TITLE_MAX_LENGTH } from "@/features/leads/lead-options";
import { isValidCalendarDate } from "@/lib/date-utils";
import { createLeadTask, getOpenLeadTask } from "@/lib/server/lead-timeline-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const calendarDate = z.string().refine(isValidCalendarDate);

const createSchema = z.object({
  title: z.string().trim().min(1).max(TASK_TITLE_MAX_LENGTH),
  description: z.string().trim().max(TASK_DESCRIPTION_MAX_LENGTH).nullish().transform((value) => value ? value : null),
  startDate: calendarDate,
  dueDate: calendarDate,
  // A status chosen in the drawer but not saved yet: it is saved together with the task.
  status: z.enum(LEAD_STATUSES).optional(),
}).strict().refine((value) => value.dueDate >= value.startDate, { message: "The due date must be on or after the start date." });

// The lead's one open follow-up task, or null.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const leadId = requireLeadId((await params).id);
    const context = await resolveTenantRequestContext();
    return createSuccessResponse({ openTask: await getOpenLeadTask(context, leadId) });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

// Creates the lead's open task. Refused while the lead is still "New Lead" (422 STATUS_REQUIRED: update the status first)
// and when a second open task would exist (409 OPEN_TASK_EXISTS, enforced by the database). An optional `status`
// is the lead's new status, saved right after the task so a status change is only recorded with its follow-up.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const leadId = requireLeadId((await params).id);
    const input = await parseJsonBody(request, createSchema);
    const context = await resolveTenantRequestContext();
    const { status, ...task } = input;
    return createSuccessResponse(await createLeadTask(context, leadId, task, status), 201);
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

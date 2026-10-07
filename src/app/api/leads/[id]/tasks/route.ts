import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { requireLeadId } from "@/app/api/leads/_lib/route-params";
import { LEAD_STATUSES, TASK_DESCRIPTION_MAX_LENGTH, TASK_REPEAT_RULES, TASK_TITLE_MAX_LENGTH } from "@/features/leads/lead-options";
import { TIME_PATTERN } from "@/features/leads/task-schedule";
import { isValidCalendarDate } from "@/lib/date-utils";
import { createLeadTask, getOpenLeadTask } from "@/lib/server/lead-timeline-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const calendarDate = z.string().refine(isValidCalendarDate);

const createSchema = z.object({
  title: z.string().trim().min(1).max(TASK_TITLE_MAX_LENGTH),
  description: z.string().trim().max(TASK_DESCRIPTION_MAX_LENGTH).nullish().transform((value) => value ? value : null),
  dueDate: calendarDate,
  // Company-clock HH:mm. A browser still on the previous build sends no time: its task is due at the end of the day.
  dueTime: z.string().regex(TIME_PATTERN).default("23:59"),
  repeat: z.enum(TASK_REPEAT_RULES).default("none"),
  // Sent only by the previous build. The task now starts when it is created, so this is ignored.
  startDate: calendarDate.optional(),
  // A status chosen in the drawer but not saved yet: it is saved together with the task.
  status: z.enum(LEAD_STATUSES).optional(),
}).strict();

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

// Creates the lead's open task. Refused while the lead is still "New Lead" (422 STATUS_REQUIRED: update the status first),
// when the due time is not in the future (422 DUE_IN_PAST) and when a second open task would exist (409 OPEN_TASK_EXISTS,
// enforced by the database). An optional `status` is the lead's new status, saved right after the task so a status
// change is only recorded with its follow-up.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const leadId = requireLeadId((await params).id);
    const input = await parseJsonBody(request, createSchema);
    const context = await resolveTenantRequestContext();
    const task = { title: input.title, description: input.description, dueDate: input.dueDate, dueTime: input.dueTime, repeatRule: input.repeat };
    return createSuccessResponse(await createLeadTask(context, leadId, task, input.status), 201);
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

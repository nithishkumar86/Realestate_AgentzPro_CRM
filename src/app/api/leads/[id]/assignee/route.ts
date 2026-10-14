import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { requireLeadId } from "@/app/api/leads/_lib/route-params";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { assignLead } from "@/lib/server/lead-assignment-service";

const bodySchema = z.object({ assigneeUserId: z.string().uuid().nullable() }).strict();

// Owner only: assigns one lead to an active member of the caller's own company, or unassigns it (null).
// The tenant and the actor come from the session only; the database re-checks both (owner + active
// assignee) and writes the timeline row.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const leadId = requireLeadId((await params).id);
    const { assigneeUserId } = await parseJsonBody(request, bodySchema);
    const access = await requireCrmAccess();
    return createSuccessResponse(await assignLead(access, leadId, assigneeUserId));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

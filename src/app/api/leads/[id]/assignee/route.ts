import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { requireLeadId } from "@/app/api/leads/_lib/route-params";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { assignLead } from "@/lib/server/lead-assignment-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const bodySchema = z.object({ assigneeUserId: z.string().uuid().nullable() }).strict();

// Assigns one lead to an active member of the caller's own company, or unassigns it (null). The tenant and
// the actor come from the session only; the database re-checks both and writes the timeline row.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const leadId = requireLeadId((await params).id);
    const { assigneeUserId } = await parseJsonBody(request, bodySchema);
    const context = await resolveTenantRequestContext();
    return createSuccessResponse(await assignLead(context, leadId, assigneeUserId));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

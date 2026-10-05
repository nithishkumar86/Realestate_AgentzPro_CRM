import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { requireLeadId } from "@/app/api/leads/_lib/route-params";
import { NOTE_MAX_LENGTH } from "@/features/leads/lead-options";
import { addLeadNote } from "@/lib/server/lead-timeline-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const bodySchema = z.object({ body: z.string().trim().min(1).max(NOTE_MAX_LENGTH) }).strict();

// Adds one note to a lead. Notes are immutable: there is no edit or delete route. The timeline row is
// written by the database trigger in the same transaction.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const leadId = requireLeadId((await params).id);
    const { body } = await parseJsonBody(request, bodySchema);
    const context = await resolveTenantRequestContext();
    return createSuccessResponse(await addLeadNote(context, leadId, body), 201);
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

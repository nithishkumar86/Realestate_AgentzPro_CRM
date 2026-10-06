import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { setAdAssignmentRule } from "@/lib/server/lead-assignment-service";

export const runtime = "nodejs";

const bodySchema = z.object({ adId: z.string().trim().min(1).max(100), assigneeUserId: z.string().uuid().nullable() }).strict();

/** Owner only: who receives new leads from one ad. assigneeUserId null clears the rule. */
export async function PUT(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { adId, assigneeUserId } = await parseJsonBody(request, bodySchema);
    await setAdAssignmentRule(await requireCrmAccess(), adId, assigneeUserId);
    return createSuccessResponse({ adId, assigneeUserId });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

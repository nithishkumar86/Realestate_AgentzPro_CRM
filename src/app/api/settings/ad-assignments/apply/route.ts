import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { applyAdAssignmentRule } from "@/lib/server/lead-assignment-service";

export const runtime = "nodejs";

const bodySchema = z.object({ adId: z.string().trim().min(1).max(100) }).strict();

/** Owner only: gives the ad's assignee every lead of that ad that is still unassigned. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { adId } = await parseJsonBody(request, bodySchema);
    return createSuccessResponse(await applyAdAssignmentRule(await requireCrmAccess(), adId));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

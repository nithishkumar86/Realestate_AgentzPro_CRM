import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { setActiveTenant } from "@/lib/server/auth/active-tenant";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { requireActiveMembership } from "@/lib/server/workspace-service";
import { requireSessionUserId, withNoStore } from "../_lib/route-helpers";

export const runtime = "nodejs";

const requestSchema = z.object({ tenantId: z.string().uuid() }).strict();

/**
 * Switches the signed-in person's active company. The tenant id comes from the browser, so it is
 * checked against the caller's own active memberships before the cookie is written — and every
 * later request re-checks it again in requireCrmAccess.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const userId = await requireSessionUserId();
    const { tenantId } = await parseJsonBody(request, requestSchema);
    const normalizedTenantId = tenantId.toLowerCase();

    await requireActiveMembership(userId, normalizedTenantId);

    const response = createSuccessResponse({ tenantId: normalizedTenantId, redirectTo: "/" });
    setActiveTenant(response, normalizedTenantId);
    return withNoStore(response);
  } catch (error) {
    return withNoStore(createErrorResponse(error, request));
  }
}

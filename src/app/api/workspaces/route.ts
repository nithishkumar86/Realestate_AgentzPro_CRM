import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { setActiveTenant } from "@/lib/server/auth/active-tenant";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { createOwnedWorkspace } from "@/lib/server/workspace-service";
import { requireSessionUserId, withNoStore } from "./_lib/route-helpers";

export const runtime = "nodejs";

/**
 * "Create new company": the signed-in person becomes owner of a new tenant, reusing their existing
 * profile. At most one owned company per person — a repeat call returns the same company.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    await requireSessionUserId();

    const rawBody = await request.json().catch(() => null);
    const result = await createOwnedWorkspace(rawBody);

    const response = createSuccessResponse({ tenantId: result.tenantId, redirectTo: "/" }, 201);
    setActiveTenant(response, result.tenantId);
    return withNoStore(response);
  } catch (error) {
    return withNoStore(createErrorResponse(error, request));
  }
}

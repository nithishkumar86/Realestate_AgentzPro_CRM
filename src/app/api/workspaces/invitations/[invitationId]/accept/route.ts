import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { setActiveTenant } from "@/lib/server/auth/active-tenant";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { joinInvitedWorkspace } from "@/lib/server/member-invitation-service";
import { requireSessionUserId, withNoStore } from "../../../_lib/route-helpers";

export const runtime = "nodejs";

/**
 * One-click accept for someone who already has an account. No personal details are sent: the
 * company and role come from the invitation, and the name, phone, and job title from the profile.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ invitationId: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(request);
    await requireSessionUserId();
    const { invitationId } = await params;

    const result = await joinInvitedWorkspace(invitationId);

    const response = createSuccessResponse({ tenantId: result.tenantId, redirectTo: "/" }, 201);
    setActiveTenant(response, result.tenantId);
    return withNoStore(response);
  } catch (error) {
    return withNoStore(createErrorResponse(error, request));
  }
}

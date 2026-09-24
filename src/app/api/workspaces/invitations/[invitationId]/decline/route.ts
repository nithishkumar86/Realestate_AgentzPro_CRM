import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { declineInvitation } from "@/lib/server/member-invitation-service";
import { requireSessionUserId, withNoStore } from "../../../_lib/route-helpers";

export const runtime = "nodejs";

/** The signed-in person turns down one of their own pending invitations. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ invitationId: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(request);
    await requireSessionUserId();
    const { invitationId } = await params;

    await declineInvitation(invitationId);
    return withNoStore(createSuccessResponse({ invitationId }));
  } catch (error) {
    return withNoStore(createErrorResponse(error, request));
  }
}

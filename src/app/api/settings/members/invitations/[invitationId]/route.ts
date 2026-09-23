import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { AppError } from "@/lib/server/app-error";
import { cancelMemberInvitation } from "@/lib/server/member-invitation-service";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner-only: withdraws one pending invitation from the caller's own tenant. */
export async function DELETE(request: Request, { params }: { params: Promise<{ invitationId: string }> }): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { invitationId } = await params;
    if (!UUID_PATTERN.test(invitationId)) {
      throw new AppError("A valid invitation id is required.", { status: 400, code: "INVALID_INVITATION_ID" });
    }
    const access = await requireCrmAccess();
    await cancelMemberInvitation(access, invitationId);
    return createSuccessResponse({ invitationId });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

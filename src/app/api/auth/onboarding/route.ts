import { createSuccessResponse, createErrorResponse } from "@/app/api/meta/_lib/route-utils";
import { AppError } from "@/lib/server/app-error";
import { verifySession } from "@/lib/server/auth/session";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { completeOwnerOnboarding } from "@/lib/server/auth/onboarding-service";
import { findPendingInvitationForUser, findWithdrawnInvitationForUser } from "@/lib/server/member-invitation-service";

export const runtime = "nodejs";

/**
 * Session-guarded owner onboarding (login_system_plan.md section 6.4).
 * The session check here gives an unauthenticated caller a clear 401
 * before any RPC call; the complete_owner_onboarding RPC itself also
 * independently rejects an unauthenticated caller, since it derives
 * user_id exclusively from auth.uid() and never trusts a value from this
 * request body.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const session = await verifySession();
    if (!session) {
      throw new AppError("Authentication is required to complete onboarding.", {
        status: 401,
        code: "UNAUTHENTICATED",
      });
    }

    // An invited person joins the inviting company's tenant through
    // /api/auth/onboarding/invitation; they must never create a tenant of their own here.
    if (await findPendingInvitationForUser(session.userId)) {
      throw new AppError("You have a pending invitation. Complete setup from the invitation form.", {
        status: 409,
        code: "INVITATION_PENDING",
      });
    }
    if (await findWithdrawnInvitationForUser(session.userId)) {
      throw new AppError("This invitation was withdrawn by the organization owner.", {
        status: 409,
        code: "INVITATION_WITHDRAWN",
      });
    }

    const rawBody = await request.json().catch(() => null);
    const result = await completeOwnerOnboarding(rawBody);

    return createSuccessResponse(result, 201);
  } catch (error) {
    return createErrorResponse(error);
  }
}

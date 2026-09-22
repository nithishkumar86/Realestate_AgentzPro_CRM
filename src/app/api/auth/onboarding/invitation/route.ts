import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { AppError } from "@/lib/server/app-error";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { verifySession } from "@/lib/server/auth/session";
import { acceptMemberInvitation } from "@/lib/server/member-invitation-service";

export const runtime = "nodejs";

/**
 * Invited member setup. Joins the inviting tenant with the invitation's role; never creates a
 * tenant. The accept_member_invitation RPC derives the user from auth.uid() itself.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const session = await verifySession();
    if (!session) {
      throw new AppError("Authentication is required to complete setup.", { status: 401, code: "UNAUTHENTICATED" });
    }

    const rawBody = await request.json().catch(() => null);
    return createSuccessResponse(await acceptMemberInvitation(rawBody), 201);
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

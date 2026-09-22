import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { sendMemberInvitations } from "@/lib/server/member-invitation-service";

export const runtime = "nodejs";

/**
 * Owner-only: records invitations into the caller's tenant and sends the invite emails. The
 * tenant, inviter, and owner check all come from the verified session; the body carries only
 * email + role pairs.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const access = await requireCrmAccess();
    const rawBody = await request.json().catch(() => null);
    const redirectTo = new URL("/auth/confirm", request.url).toString();

    const results = await sendMemberInvitations(access, rawBody, redirectTo);
    return createSuccessResponse({ results });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

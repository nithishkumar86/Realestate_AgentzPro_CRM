import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { AppError } from "@/lib/server/app-error";
import { removeTenantMember } from "@/lib/server/member-invitation-service";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner-only: removes one employee membership from the caller's own tenant. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ memberUserId: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { memberUserId } = await params;
    if (!UUID_PATTERN.test(memberUserId)) {
      throw new AppError("A valid member id is required.", { status: 400, code: "INVALID_MEMBER_ID" });
    }
    const access = await requireCrmAccess();
    await removeTenantMember(access, memberUserId);
    return createSuccessResponse({ memberUserId });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

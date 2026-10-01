import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { AppError } from "@/lib/server/app-error";
import { setTenantMemberAccess } from "@/lib/server/member-invitation-service";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner-only: blocks or enables one employee of the caller's own tenant. Body: { access: "active" | "blocked" }. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ memberUserId: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { memberUserId } = await params;
    if (!UUID_PATTERN.test(memberUserId)) {
      throw new AppError("A valid member id is required.", { status: 400, code: "INVALID_MEMBER_ID" });
    }
    const body = (await request.json().catch(() => null)) as { access?: unknown } | null;
    const memberAccess = body?.access;
    if (memberAccess !== "active" && memberAccess !== "blocked") {
      throw new AppError("Access must be active or blocked.", { status: 400, code: "INVALID_MEMBER_ACCESS" });
    }
    const access = await requireCrmAccess();
    await setTenantMemberAccess(access, memberUserId, memberAccess);
    return createSuccessResponse({ memberUserId, access: memberAccess });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

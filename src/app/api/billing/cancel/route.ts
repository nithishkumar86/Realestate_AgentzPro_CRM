import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireBillingOwner } from "@/lib/server/auth/access";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { cancelAtPeriodEnd } from "@/lib/server/billing-service";

export const runtime = "nodejs";

/** Owner-only: stop renewing at the end of the paid period. Access continues until then. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const access = await requireBillingOwner();
    return createSuccessResponse(await cancelAtPeriodEnd(access));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

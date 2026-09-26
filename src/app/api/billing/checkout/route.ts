import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireBillingOwner } from "@/lib/server/auth/access";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { startCheckout } from "@/lib/server/billing-service";

export const runtime = "nodejs";

/**
 * Owner-only: creates the Razorpay subscription for the caller's ACTIVE company and returns its id for
 * Razorpay Checkout. The body carries only the plan code and seat count; the company comes from the
 * verified session. Works for blocked companies too — they are the ones that need to pay.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const access = await requireBillingOwner();
    const rawBody = await request.json().catch(() => null);
    return createSuccessResponse(await startCheckout(access, rawBody));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

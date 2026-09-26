import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireBillingMember } from "@/lib/server/auth/access";

export const runtime = "nodejs";

/**
 * Polled by the "Activating your plan…" screen after Razorpay Checkout closes. It only REPORTS what the
 * webhook has written; the browser never unlocks anything itself.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const access = await requireBillingMember();
    return withNoStore(
      createSuccessResponse({
        subscriptionStatus: access.subscriptionStatus,
        currentPeriodEndsAt: access.currentPeriodEndsAt,
        hasCrmAccess: access.hasCrmAccess,
      }),
    );
  } catch (error) {
    return withNoStore(createErrorResponse(error, request));
  }
}

function withNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Vary", "Cookie");
  return response;
}

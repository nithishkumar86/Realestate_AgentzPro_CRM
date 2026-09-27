import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireBillingMember } from "@/lib/server/auth/access";
import { getBillingOverview } from "@/lib/server/billing-service";

export const runtime = "nodejs";

/**
 * Read-only billing overview of the active company, for Settings → Billing. Any active member may read it;
 * payment history is filled for the owner only. The company comes from the session only.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const access = await requireBillingMember();
    return withNoStore(createSuccessResponse({ overview: await getBillingOverview(access) }));
  } catch (error) {
    return withNoStore(createErrorResponse(error, request));
  }
}

function withNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Vary", "Cookie");
  return response;
}

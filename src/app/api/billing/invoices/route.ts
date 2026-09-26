import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireBillingOwner } from "@/lib/server/auth/access";
import { listBillingPayments } from "@/lib/server/billing-service";

export const runtime = "nodejs";

/** Owner-only: the active company's invoices, newest first. The company comes from the session only. */
export async function GET(request: Request): Promise<Response> {
  try {
    const access = await requireBillingOwner();
    return withNoStore(createSuccessResponse({ invoices: await listBillingPayments(access) }));
  } catch (error) {
    return withNoStore(createErrorResponse(error, request));
  }
}

function withNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Vary", "Cookie");
  return response;
}

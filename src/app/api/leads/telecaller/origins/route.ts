import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { listCallInOrigins } from "@/lib/server/telecaller-lead-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

// Read-only: what the "+" form offers for "Came from" (platforms connected right now, with their named ads or
// campaigns) and the call-date range. Any active member may read it, since any member may add a call-in lead.
export async function GET(request: Request) {
  try {
    const context = await resolveTenantRequestContext();
    return createSuccessResponse(await listCallInOrigins(context));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

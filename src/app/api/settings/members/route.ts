import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { listTenantMembers } from "@/lib/server/member-invitation-service";

export const runtime = "nodejs";

/** Members of the caller's own tenant plus its open invitations. The tenant comes from the session only. */
export async function GET(request: Request): Promise<Response> {
  try {
    const access = await requireCrmAccess();
    return withNoStore(createSuccessResponse(await listTenantMembers(access)));
  } catch (error) {
    return withNoStore(createErrorResponse(error, request));
  }
}

function withNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Vary", "Cookie");
  return response;
}

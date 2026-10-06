import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { listAdAssignments } from "@/lib/server/lead-assignment-service";

export const runtime = "nodejs";

/** Owner only: the company's ads with who receives each ad's leads. The tenant comes from the session only. */
export async function GET(request: Request): Promise<Response> {
  try {
    return withNoStore(createSuccessResponse(await listAdAssignments(await requireCrmAccess())));
  } catch (error) {
    return withNoStore(createErrorResponse(error, request));
  }
}

function withNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Vary", "Cookie");
  return response;
}

import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { AppError } from "@/lib/server/app-error";
import { setSessionActivity } from "@/lib/server/auth/idle-session";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { verifySession } from "@/lib/server/auth/session";

export const runtime = "nodejs";

/**
 * Heartbeat from the browser idle tracker, sent only on real user activity.
 * src/proxy.ts has already refused an idle session before this runs, so a
 * session reaching here is still live and its idle clock is renewed with
 * the server's own time; the request body carries nothing.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const session = await verifySession();
    if (!session) {
      throw new AppError("Not signed in.", { status: 401, code: "UNAUTHENTICATED" });
    }
    const response = createSuccessResponse({ active: true });
    setSessionActivity(response, session.userId);
    return withNoStore(response);
  } catch (error) {
    return withNoStore(createErrorResponse(error, request));
  }
}

function withNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  return response;
}

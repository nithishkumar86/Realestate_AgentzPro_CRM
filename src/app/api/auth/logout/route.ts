import { createSuccessResponse, createErrorResponse } from "@/app/api/meta/_lib/route-utils";
import { createAuthClient } from "@/lib/server/auth/supabase-auth-client";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);

    const supabase = await createAuthClient();
    const { error } = await supabase.auth.signOut();
    if (error) {
      throw error;
    }

    return withNoStore(createSuccessResponse({ signedOut: true }));
  } catch (error) {
    return withNoStore(createErrorResponse(error));
  }
}

/**
 * This response carries the Set-Cookie headers that clear the session, so
 * it must never be stored by a CDN or intermediate proxy.
 */
function withNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

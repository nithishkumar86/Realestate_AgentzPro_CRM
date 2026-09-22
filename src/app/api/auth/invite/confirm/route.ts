import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { AppError } from "@/lib/server/app-error";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { createAuthClient } from "@/lib/server/auth/supabase-auth-client";

export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
} as const;

/**
 * Turns the link in a Supabase invite email into this app's cookie session. Two link formats reach
 * /auth/confirm, and both are accepted so the invite works whichever email template is configured:
 *
 * - `?token_hash=…&type=invite` from a customised template: verified here with verifyOtp().
 * - The default template, whose link goes through Supabase's /verify endpoint and returns with
 *   `#access_token=…&refresh_token=…&type=invite` in the URL fragment. A fragment never reaches
 *   the server, so /auth/confirm posts it here and setSession() validates it with Supabase Auth
 *   before any cookie is written.
 */
const requestSchema = z.union([
  z.object({ tokenHash: z.string().trim().min(1).max(512) }),
  z.object({ accessToken: z.string().trim().min(1).max(8192), refreshToken: z.string().trim().min(1).max(512) }),
]);

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await parseJsonBody(request, requestSchema);
    const supabase = await createAuthClient();

    const { data, error } =
      "tokenHash" in body
        ? await supabase.auth.verifyOtp({ type: "invite", token_hash: body.tokenHash })
        : await supabase.auth.setSession({ access_token: body.accessToken, refresh_token: body.refreshToken });

    if (error || !data.user) {
      console.warn(JSON.stringify({ operation: "invite_confirm", reason: "INVITE_LINK_INVALID_OR_EXPIRED" }));
      throw new AppError("This invitation link is invalid or has expired. Sign in with your email to continue.", {
        status: 401,
        code: "INVITE_LINK_INVALID",
      });
    }

    return withNoStore(createSuccessResponse({ redirectTo: "/onboarding" }));
  } catch (error) {
    return withNoStore(createErrorResponse(error, request));
  }
}

function withNoStore(response: Response): Response {
  for (const [key, value] of Object.entries(NO_STORE_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

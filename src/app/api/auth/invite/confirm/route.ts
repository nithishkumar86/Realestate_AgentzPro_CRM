import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { AppError } from "@/lib/server/app-error";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { createAuthClient } from "@/lib/server/auth/supabase-auth-client";
import { findWithdrawnInvitationById } from "@/lib/server/member-invitation-service";

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
 *
 * Every invite link also carries `?invitation=<id>`. That is checked first: if the owner withdrew
 * the invitation, the response says so and no session is created — on the first click and on every
 * later one, including after Supabase has already used up or rejected the one-time token (in which
 * case no credential arrives at all).
 */
const requestSchema = z
  .object({
    invitationId: z.string().uuid().optional(),
    tokenHash: z.string().trim().min(1).max(512).optional(),
    accessToken: z.string().trim().min(1).max(8192).optional(),
    refreshToken: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await parseJsonBody(request, requestSchema);

    if (body.invitationId) {
      const withdrawn = await findWithdrawnInvitationById(body.invitationId);
      if (withdrawn) {
        throw new AppError("This invitation was withdrawn by the organization owner.", {
          status: 410,
          code: "INVITATION_WITHDRAWN",
          details: { tenantName: withdrawn.tenantName },
        });
      }
    }

    const supabase = await createAuthClient();
    const result = body.tokenHash
      ? await supabase.auth.verifyOtp({ type: "invite", token_hash: body.tokenHash })
      : body.accessToken && body.refreshToken
        ? await supabase.auth.setSession({ access_token: body.accessToken, refresh_token: body.refreshToken })
        : null;

    if (!result || result.error || !result.data.user) {
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

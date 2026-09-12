import { z } from "zod";
import { parseJsonBody, createSuccessResponse, createErrorResponse } from "@/app/api/meta/_lib/route-utils";
import { verifyOtp } from "@/lib/server/auth/otp-service";
import { getRequestSourceIp } from "@/lib/server/auth/request-ip";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { resolveLoginState } from "@/lib/server/auth/login-state";
import { evaluateCrmAccess } from "@/lib/server/auth/access";

export const runtime = "nodejs";

/**
 * This response carries the Set-Cookie headers that establish the session.
 * It must never be stored by a CDN or intermediate proxy, or one user's
 * session token can be served to another.
 */
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
} as const;

const requestSchema = z.object({
  email: z.string().trim().min(1).max(320),
  otp: z.string().trim().min(1).max(16),
});

/**
 * login_system_plan.md section 6.2/6.3: verifies the OTP, then resolves
 * the caller's login state to decide where the client should navigate
 * next — /onboarding for a first-time user, /leads for valid access, or
 * /billing for an expired/blocked/integrity-error account. A failed or
 * blocked verification never creates or reveals any application row.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await parseJsonBody(request, requestSchema);
    const sourceIp = getRequestSourceIp(request);

    const result = await verifyOtp({ email: body.email, otp: body.otp, sourceIp });

    if (!result.verified || !result.userId) {
      return withNoStore(createSuccessResponse({ verified: false, blocked: result.blocked ?? false }, 401));
    }

    const state = await resolveLoginState(result.userId);
    const redirectTo = resolvePostLoginDestination(state);

    return withNoStore(createSuccessResponse({ verified: true, redirectTo }));
  } catch (error) {
    return withNoStore(createErrorResponse(error));
  }
}

function withNoStore(response: Response): Response {
  for (const [key, value] of Object.entries(NO_STORE_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

function resolvePostLoginDestination(state: Awaited<ReturnType<typeof resolveLoginState>>): "/onboarding" | "/billing" | "/leads" {
  if (state.status === "needs_onboarding") {
    return "/onboarding";
  }
  if (state.status === "integrity_error" || !evaluateCrmAccess(state)) {
    return "/billing";
  }
  return "/leads";
}

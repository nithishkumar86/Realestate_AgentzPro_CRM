import { z } from "zod";
import { parseJsonBody, createSuccessResponse, createErrorResponse } from "@/app/api/meta/_lib/route-utils";
import { verifyOtp } from "@/lib/server/auth/otp-service";
import { getRequestSourceIp } from "@/lib/server/auth/request-ip";
import { resolveLoginState } from "@/lib/server/auth/login-state";
import { evaluateCrmAccess } from "@/lib/server/auth/access";

export const runtime = "nodejs";

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
    const body = await parseJsonBody(request, requestSchema);
    const sourceIp = getRequestSourceIp(request);

    const result = await verifyOtp({ email: body.email, otp: body.otp, sourceIp });

    if (!result.verified || !result.userId) {
      return createSuccessResponse({ verified: false, blocked: result.blocked ?? false }, 401);
    }

    const state = await resolveLoginState(result.userId);
    const redirectTo = resolvePostLoginDestination(state);

    return createSuccessResponse({ verified: true, redirectTo });
  } catch (error) {
    return createErrorResponse(error);
  }
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

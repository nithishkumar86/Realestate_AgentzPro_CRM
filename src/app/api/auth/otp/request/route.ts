import { z } from "zod";
import { parseJsonBody, createSuccessResponse, createErrorResponse } from "@/app/api/meta/_lib/route-utils";
import { requestOtp } from "@/lib/server/auth/otp-service";
import { getRequestSourceIp } from "@/lib/server/auth/request-ip";

export const runtime = "nodejs";

const requestSchema = z.object({
  email: z.string().trim().min(1).max(320),
  turnstileToken: z.string(),
});

/**
 * login_system_plan.md section 6.1 / 10.4: Turnstile, then the Upstash
 * email-cooldown, email-hourly, and IP-hourly checks, then
 * signInWithOtp() — all orchestrated inside requestOtp(). This route
 * always returns the same generic success response regardless of which
 * internal check passed or failed, so the response can never be used to
 * enumerate whether an email address is already registered.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await parseJsonBody(request, requestSchema);
    const sourceIp = getRequestSourceIp(request);

    await requestOtp({ email: body.email, turnstileToken: body.turnstileToken, sourceIp });

    return createSuccessResponse({ message: "If this email is eligible, a verification code has been sent." });
  } catch (error) {
    return createErrorResponse(error);
  }
}

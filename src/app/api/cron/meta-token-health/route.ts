import { createSuccessResponse, createErrorResponse } from "@/app/api/meta/_lib/route-utils";
import { AppError } from "@/lib/server/app-error";
import { isConstantTimeMatch } from "@/lib/server/webhook-security";
import { getAuthEnv } from "@/lib/server/env";
import { MetaTokenHealthService } from "@/lib/server/meta-token-health-service";

export const runtime = "nodejs";
// Each connection costs one debug_token call and they run sequentially to stay inside Meta's
// app-level rate limit, so a full batch needs well past the default execution window.
export const maxDuration = 300;

const CRON_SECRET_HEADER = "x-cron-secret";

/**
 * Daily Meta token health check.
 *
 * Required by Meta for server-to-server integrations: "If you don't use the Facebook SDKs in your app, it
 * is extremely important that you manually implement frequent checks of the token validity - at least
 * daily" (https://developers.facebook.com/docs/facebook-login/best-practices/).
 *
 * Schedule this at least once every 24 hours. It is idempotent and safe to run more often; each run takes
 * the least-recently-verified connections first, so a batch cap still rotates through all of them.
 *
 * Shares SUBSCRIPTION_CRON_SECRET with the subscription reconciliation cron rather than introducing
 * another environment variable: both are the same operator calling the same deployment.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const suppliedSecret = request.headers.get(CRON_SECRET_HEADER);
    const expectedSecret = getAuthEnv().SUBSCRIPTION_CRON_SECRET;

    if (!suppliedSecret || !isConstantTimeMatch(expectedSecret, suppliedSecret)) {
      throw new AppError("The request could not be authenticated.", { status: 403, code: "CRON_UNAUTHORIZED" });
    }

    return createSuccessResponse(await new MetaTokenHealthService().revalidateActiveConnections());
  } catch (error) {
    return createErrorResponse(error);
  }
}

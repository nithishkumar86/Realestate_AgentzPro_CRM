import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { GoogleConnectionService } from "@/lib/server/google/google-connection-service";

export const runtime = "nodejs";

// Google Ads card on the Connection page: sign-in status, linked accounts and (owner only) the webhook.
export async function GET(request: Request) {
  try {
    return createSuccessResponse(await new GoogleConnectionService().getOverview(new URL(request.url).origin));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

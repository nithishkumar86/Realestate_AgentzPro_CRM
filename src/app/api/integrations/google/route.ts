import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { GoogleConnectionService } from "@/lib/server/google/google-connection-service";

export const runtime = "nodejs";

// Google Ads card on the Connection page: sign-in status, linked accounts and (owner only) the webhook.
// ?campaigns=1 (sent only by that card) adds the campaigns Google has delivered leads from.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    return createSuccessResponse(await new GoogleConnectionService().getOverview(url.origin, { includeCampaigns: url.searchParams.get("campaigns") === "1" }));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

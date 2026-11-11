import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { CustomWebhookConnectionService } from "@/lib/server/custom-webhook/custom-webhook-connection-service";

export const runtime = "nodejs";

// The company's custom webhook. GET: whether it is on or stopped (the /leads and dashboard source check); with
// ?details=1, sent only by the Connection card, the owner also gets the URL. POST: create it, or replace the URL.
// DELETE: stop webhook leads. POST and DELETE are owner only.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    return createSuccessResponse(await new CustomWebhookConnectionService().getOverview(url.origin, { includeUrl: url.searchParams.get("details") === "1" }));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return createSuccessResponse(await new CustomWebhookConnectionService().createOrReplace(new URL(request.url).origin));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    await new CustomWebhookConnectionService().stop();
    return createSuccessResponse({ stopped: true });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

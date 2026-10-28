import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { GoogleConnectionService } from "@/lib/server/google/google-connection-service";

export const runtime = "nodejs";

// Creates the tenant's lead-form webhook URL + key, or replaces the key.
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return createSuccessResponse(await new GoogleConnectionService().createOrRotateWebhook(new URL(request.url).origin));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

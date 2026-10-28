import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { GoogleConnectionService } from "@/lib/server/google/google-connection-service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await new GoogleConnectionService().disconnect();
    return createSuccessResponse({ disconnected: true });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

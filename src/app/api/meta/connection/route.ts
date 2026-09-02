import { ConnectionService } from "@/lib/server/connection-service";
import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";

export const runtime = "nodejs";

export async function GET() {
  try {
    return createSuccessResponse(await new ConnectionService().getOverview());
  } catch (error) {
    return createErrorResponse(error);
  }
}

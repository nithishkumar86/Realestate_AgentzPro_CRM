import { z } from "zod";
import { ConnectionService } from "@/lib/server/connection-service";
import { AppError } from "@/lib/server/app-error";
import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";

export const runtime = "nodejs";

const connectionIdSchema = z.uuid();

export async function GET(request: Request) {
  try {
    const connectionId = connectionIdSchema.safeParse(new URL(request.url).searchParams.get("connection_id"));
    if (!connectionId.success) {
      throw new AppError("Connection ID is invalid.", { status: 400, code: "INVALID_REQUEST" });
    }
    return createSuccessResponse({ pages: await new ConnectionService().getEligiblePages(connectionId.data) });
  } catch (error) {
    return createErrorResponse(error);
  }
}

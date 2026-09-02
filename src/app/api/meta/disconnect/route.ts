import { z } from "zod";
import { ConnectionService } from "@/lib/server/connection-service";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";

export const runtime = "nodejs";

const disconnectConnectionSchema = z.object({ connection_id: z.uuid() }).strict();

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, disconnectConnectionSchema);
    return createSuccessResponse(await new ConnectionService().disconnectConnection(body.connection_id));
  } catch (error) {
    return createErrorResponse(error);
  }
}

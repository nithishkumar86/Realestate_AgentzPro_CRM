import { z } from "zod";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { ConnectionService } from "@/lib/server/connection-service";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";

export const runtime = "nodejs";

const disconnectConnectionSchema = z.object({ connection_id: z.uuid() }).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await parseJsonBody(request, disconnectConnectionSchema);
    return createSuccessResponse(await new ConnectionService().disconnectConnection(body.connection_id));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

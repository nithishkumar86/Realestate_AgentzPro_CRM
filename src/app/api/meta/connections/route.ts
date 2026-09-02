import { z } from "zod";
import { ConnectionService } from "@/lib/server/connection-service";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";

export const runtime = "nodejs";

const connectionRequestSchema = z.object({ short_lived_user_access_token: z.string().min(1).max(10_000) }).strict();

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, connectionRequestSchema);
    const result = await new ConnectionService().startConnection(body.short_lived_user_access_token);
    return createSuccessResponse(result, 201);
  } catch (error) {
    return createErrorResponse(error);
  }
}

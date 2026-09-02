import { z } from "zod";
import { ConnectionService } from "@/lib/server/connection-service";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";

export const runtime = "nodejs";

const disconnectPageSchema = z.object({ page_record_id: z.uuid() }).strict();

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, disconnectPageSchema);
    return createSuccessResponse(await new ConnectionService().disconnectPage(body.page_record_id));
  } catch (error) {
    return createErrorResponse(error);
  }
}

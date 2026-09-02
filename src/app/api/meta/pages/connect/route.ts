import { z } from "zod";
import { ConnectionService } from "@/lib/server/connection-service";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";

export const runtime = "nodejs";

const connectPagesSchema = z.object({
  connection_id: z.uuid(),
  facebook_page_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(100).refine((ids) => new Set(ids).size === ids.length),
}).strict();

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, connectPagesSchema);
    return createSuccessResponse(await new ConnectionService().connectSelectedPages(body.connection_id, body.facebook_page_ids));
  } catch (error) {
    return createErrorResponse(error);
  }
}

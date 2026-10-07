import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { markTaskNotificationsRead } from "@/lib/server/task-notification-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const bodySchema = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ ids: z.array(z.string().uuid()).min(1).max(50) }).strict(),
]);

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, bodySchema);
    await markTaskNotificationsRead(await resolveTenantRequestContext(), "all" in body ? "all" : body.ids);
    return createSuccessResponse({ ok: true });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { clearTaskNotifications } from "@/lib/server/task-notification-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const bodySchema = z.object({ all: z.literal(true) }).strict();

export async function POST(request: Request) {
  try {
    await parseJsonBody(request, bodySchema);
    await clearTaskNotifications(await resolveTenantRequestContext());
    return createSuccessResponse({ ok: true });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { listTaskNotifications } from "@/lib/server/task-notification-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

export async function GET(request: Request) {
  try {
    return createSuccessResponse(await listTaskNotifications(await resolveTenantRequestContext()));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

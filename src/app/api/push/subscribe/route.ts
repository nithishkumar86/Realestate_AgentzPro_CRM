import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { isPushServiceUrl, removePushSubscription, savePushSubscription } from "@/lib/server/push-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const endpoint = z.string().max(2000).refine(isPushServiceUrl, "Not a browser push service.");
const subscribeSchema = z.object({
  endpoint,
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }).strict(),
}).strict();
const removeSchema = z.object({ endpoint }).strict();

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, subscribeSchema);
    await savePushSubscription(await resolveTenantRequestContext(), body);
    return createSuccessResponse({ ok: true });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await parseJsonBody(request, removeSchema);
    await removePushSubscription(await resolveTenantRequestContext(), body.endpoint);
    return createSuccessResponse({ ok: true });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

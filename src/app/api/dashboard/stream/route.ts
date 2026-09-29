import { createErrorResponse } from "@/app/api/meta/_lib/route-utils";
import { AppError } from "@/lib/server/app-error";
import { subscribeToTenantChanges } from "@/lib/server/dashboard-live-relay";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Each stream closes itself well inside maxDuration and the browser's EventSource reconnects. Every
 * reconnect goes back through the proxy (idle-session check) and requireCrmAccess (session,
 * membership, tenant status, subscription), so a signed-out, idle, removed or expired user loses the
 * feed within one lifetime without any cookie handling after the response has started.
 */
const STREAM_LIFETIME_MS = 280_000;
const HEARTBEAT_MS = 20_000;
const RECONNECT_DELAY_MS = 3_000;
const MAX_STREAMS_PER_USER_PER_INSTANCE = 6;

const openStreamsByUser = new Map<string, number>();

export async function GET(request: Request): Promise<Response> {
  let context;
  try {
    context = await resolveTenantRequestContext();
    if ((openStreamsByUser.get(context.userId) ?? 0) >= MAX_STREAMS_PER_USER_PER_INSTANCE) {
      throw new AppError("Too many live dashboards are open for this account.", { status: 429, code: "TOO_MANY_STREAMS", retryable: true });
    }
  } catch (error) {
    return createErrorResponse(error, request);
  }

  const { tenantId, userId } = context;
  openStreamsByUser.set(userId, (openStreamsByUser.get(userId) ?? 0) + 1);
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };
      const sendEvent = (event: string, data: unknown) => send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const unsubscribe = subscribeToTenantChanges(tenantId, (event) => {
        if (event === "change") sendEvent("change", {});
        else sendEvent("status", { state: event });
      });
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      const lifetime = setTimeout(close, STREAM_LIFETIME_MS);

      function close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        unsubscribe();
        const remaining = (openStreamsByUser.get(userId) ?? 1) - 1;
        if (remaining <= 0) openStreamsByUser.delete(userId);
        else openStreamsByUser.set(userId, remaining);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }
      cleanup = close;

      request.signal.addEventListener("abort", close);
      send(`retry: ${RECONNECT_DELAY_MS}\n\n`);
      sendEvent("ready", { tenantId });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

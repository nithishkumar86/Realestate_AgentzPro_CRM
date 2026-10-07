import { verifyQstashRequest } from "@/lib/server/qstash-service";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const runtime = "nodejs";

/**
 * Fired every minute by the QStash schedule (scripts/ensure-task-reminder-schedule.mjs). One SQL call records
 * the alerts that came due (each at most once per task, kind and due time) and broadcasts them to the owners.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  if (!(await verifyQstashRequest(request, rawBody))) return new Response(null, { status: 403 });

  const { error } = await getSupabaseAdminClient().rpc("enqueue_task_reminders", {});
  if (error) {
    console.error(JSON.stringify({ operation: "task_reminder_worker", code: "ENQUEUE_FAILED" }));
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
}

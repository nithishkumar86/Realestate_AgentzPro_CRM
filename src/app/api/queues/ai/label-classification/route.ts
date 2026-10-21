import { LabelClassificationService } from "@/lib/server/label-classification-service";
import { isAuthorizedWorkerRequest } from "@/lib/server/worker-auth";

export const runtime = "nodejs";

// Fired every minute by Supabase pg_cron (migration 20261021120000_worker_cron_jobs.sql), or by its own
// QStash schedule (scripts/ensure-label-classification-schedule.mjs) if that is used instead,
// independent of the existing lead-retrieval and recovery schedules. Each run repairs the
// classification queue (missing rows, expired leases) and processes whatever is due, so a new
// lead is classified within about a minute without any change to the existing ingestion pipeline.
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  if (!(await isAuthorizedWorkerRequest(request, rawBody))) {
    return new Response(null, { status: 403 });
  }

  try {
    await new LabelClassificationService().processDue();
    return new Response(null, { status: 200 });
  } catch {
    console.error(JSON.stringify({ operation: "label_classification_worker", code: "WORKER_FAILED" }));
    return new Response(null, { status: 500 });
  }
}

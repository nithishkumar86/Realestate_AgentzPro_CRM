import { GoogleLeadNameService } from "@/lib/server/google/google-lead-name-service";
import { isAuthorizedWorkerRequest } from "@/lib/server/worker-auth";

export const runtime = "nodejs";

// Fired every minute by Supabase pg_cron (migration 20261028130000_google_ads_lead_names_cron.sql). Each run
// releases expired claims and fills the campaign / ad group name of Google Ads leads that are due.
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  if (!(await isAuthorizedWorkerRequest(request, rawBody))) {
    return new Response(null, { status: 403 });
  }

  try {
    await new GoogleLeadNameService().processDue();
    return new Response(null, { status: 200 });
  } catch {
    console.error(JSON.stringify({ operation: "google_lead_name_worker", code: "WORKER_FAILED" }));
    return new Response(null, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { GoogleLeadWebhookService, MAX_WEBHOOK_BODY_BYTES } from "@/lib/server/google/google-lead-webhook-service";

export const runtime = "nodejs";

// Google Ads lead-form webhook (https://developers.google.com/google-ads/webhook/docs/implementation). The
// [token] in the URL picks the tenant; the google_key in the body proves the sender. The response contract is
// Google's: 200 `{}` on success, 4XX `{message}` (not retried) for a request we will never accept, 5XX when
// saving failed on our side (retried).
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_WEBHOOK_BODY_BYTES) return NextResponse.json({ message: "Payload too large." }, { status: 413 });

  try {
    const rawBody = await request.text();
    const result = await new GoogleLeadWebhookService().ingest(token, rawBody);
    return NextResponse.json(result.status === 200 ? {} : { message: result.message }, { status: result.status });
  } catch {
    console.error(JSON.stringify({ operation: "google_lead_webhook", code: "INGESTION_FAILED" }));
    return NextResponse.json({ message: "Temporary failure, retry later." }, { status: 500 });
  }
}

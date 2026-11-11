import { NextResponse } from "next/server";
import { MAX_CUSTOM_WEBHOOK_BODY_BYTES } from "@/lib/server/custom-webhook/custom-lead-mapper";
import { CustomLeadWebhookService } from "@/lib/server/custom-webhook/custom-lead-webhook-service";

export const runtime = "nodejs";

// A company's custom webhook: any tool that can send a POST request (website form plugins, Zapier, Pabbly, the
// company's own software) sends one lead per request, as JSON or form data. The [token] in the URL is the secret and
// picks the company. Server-to-server only: there is no CORS, so a browser page cannot post here directly.
// 200 {"success":true} = saved ("duplicate": true when the same lead_id was saved before); 4XX {"error"} = never
// accepted as sent; 429 = too many leads this minute (Retry-After); 500 = our failure, safe to retry.
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_CUSTOM_WEBHOOK_BODY_BYTES) return NextResponse.json({ error: "Payload too large." }, { status: 413 });

  try {
    const rawBody = await request.text();
    const result = await new CustomLeadWebhookService().ingest(token, request.headers.get("content-type"), rawBody);
    if (result.status === 200) return NextResponse.json(result.duplicate ? { success: true, duplicate: true } : { success: true });
    if (result.status === 429) {
      return NextResponse.json({ error: result.message }, { status: 429, headers: { "retry-after": String(result.retryAfterSeconds) } });
    }
    return NextResponse.json({ error: result.message }, { status: result.status });
  } catch {
    console.error(JSON.stringify({ operation: "custom_lead_webhook", code: "INGESTION_FAILED" }));
    return NextResponse.json({ error: "Temporary failure, retry later." }, { status: 500 });
  }
}

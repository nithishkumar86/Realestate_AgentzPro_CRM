import { NextResponse } from "next/server";
import { MAX_CUSTOM_WEBHOOK_BODY_BYTES } from "@/lib/server/custom-webhook/custom-lead-mapper";
import { CustomLeadWebhookService } from "@/lib/server/custom-webhook/custom-lead-webhook-service";

export const runtime = "nodejs";

// A company's custom webhook: any tool that can send a POST request (website form plugins, Zapier, Pabbly, the
// company's own software) sends one lead per request, as JSON or form data. The [token] in the URL is the secret and
// picks the company. Server-to-server only: a request from a web browser is refused (403) before anything is read.
// 200 {"success":true} = saved ("duplicate": true when the same lead_id was saved before); 4XX {"error"} = never
// accepted as sent; 429 = too many leads this minute (Retry-After); 500 = our failure, safe to retry.
const FROM_WEB_PAGE = "Send webhook leads from a server (Zapier, Pabbly, a form plugin's webhook or your own software), not from a web page.";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  if (isBrowserRequest(request.headers)) {
    console.info(JSON.stringify({ operation: "custom_lead_webhook", code: "BROWSER_REQUEST_REFUSED" }));
    return NextResponse.json({ error: FROM_WEB_PAGE }, { status: 403 });
  }
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

/**
 * A web page's form or script posting here would put the secret URL in that page's source, where any visitor can copy
 * it, so a browser request is refused and the owner sees why at the first test. Every current browser (Chrome, Edge,
 * Firefox, Safari) adds Sec-Fetch-Site to each request and a page cannot remove it; HTTP clients used on servers (curl,
 * Python, Node.js fetch) do not send it. Not Origin: a company's own server relay may forward a visitor's Origin.
 * Not Sec-Fetch-Mode: Node.js's built-in fetch sends that one.
 */
function isBrowserRequest(headers: Headers): boolean {
  return headers.has("sec-fetch-site");
}

import { ZodError } from "zod";
import { LeadWebhookService } from "@/lib/server/lead-webhook-service";
import { getMetaEnv } from "@/lib/server/env";
import { isConstantTimeMatch, verifyMetaWebhookSignature } from "@/lib/server/webhook-security";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const mode = requestUrl.searchParams.get("hub.mode");
  const verifyToken = requestUrl.searchParams.get("hub.verify_token");
  const challenge = requestUrl.searchParams.get("hub.challenge");

  // getMetaEnv() throws when Meta configuration is missing. Inside the guard, so a configuration problem
  // fails the handshake as an explicit 403 instead of an unhandled 500.
  try {
    if (!verifyToken || !challenge || mode !== "subscribe" || !isConstantTimeMatch(getMetaEnv().META_WEBHOOK_VERIFY_TOKEN, verifyToken)) {
      return new Response(null, { status: 403 });
    }
  } catch {
    console.error(JSON.stringify({ operation: "lead_webhook_verification", code: "CONFIGURATION_UNAVAILABLE" }));
    return new Response(null, { status: 403 });
  }
  return new Response(challenge, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = Buffer.from(await request.arrayBuffer());

  // Unverified payloads are rejected before any parsing or database work. A configuration failure here
  // must also reject rather than surface as a 500, which Meta would treat as a delivery failure.
  try {
    if (!verifyMetaWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
      return new Response(null, { status: 403 });
    }
  } catch {
    console.error(JSON.stringify({ operation: "lead_webhook_ingestion", code: "CONFIGURATION_UNAVAILABLE" }));
    return new Response(null, { status: 403 });
  }

  try {
    await new LeadWebhookService().ingest(rawBody.toString("utf8"));
    return new Response(null, { status: 200 });
  } catch (error) {
    // The signature already proved this payload came from Meta, so a shape we cannot parse will never
    // parse on redelivery. Meta retries any non-200 "with decreasing frequency over the next 36 hours"
    // (https://developers.facebook.com/docs/graph-api/webhooks/getting-started), so answering 400 here
    // bought 36 hours of pointless retries instead of surfacing the problem. Acknowledge and record it.
    if (error instanceof ZodError || error instanceof SyntaxError) {
      console.error(JSON.stringify({ operation: "lead_webhook_ingestion", code: "PAYLOAD_UNPROCESSABLE" }));
      return new Response(null, { status: 200 });
    }
    // Genuine server-side failures (database, queue) must stay non-200 so Meta redelivers the lead.
    console.error(JSON.stringify({ operation: "lead_webhook_ingestion", code: "INGESTION_FAILED" }));
    return new Response(null, { status: 500 });
  }
}

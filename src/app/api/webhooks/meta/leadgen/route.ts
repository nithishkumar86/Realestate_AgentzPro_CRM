import { ZodError } from "zod";
import { LeadWebhookService, parseMetaLeadWebhook } from "@/lib/server/lead-webhook-service";
import { getMetaEnv } from "@/lib/server/env";
import { isConstantTimeMatch, verifyMetaWebhookSignature } from "@/lib/server/webhook-security";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const mode = requestUrl.searchParams.get("hub.mode");
  const verifyToken = requestUrl.searchParams.get("hub.verify_token");
  const challenge = requestUrl.searchParams.get("hub.challenge");

  if (!verifyToken || !challenge || mode !== "subscribe" || !isConstantTimeMatch(getMetaEnv().META_WEBHOOK_VERIFY_TOKEN, verifyToken)) {
    return new Response(null, { status: 403 });
  }
  return new Response(challenge, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = Buffer.from(await request.arrayBuffer());
  if (!verifyMetaWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    return new Response(null, { status: 403 });
  }

  try {
    const rawBodyText = rawBody.toString("utf8");
    parseMetaLeadWebhook(rawBodyText);
    await new LeadWebhookService().ingest(rawBodyText);
    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return new Response(null, { status: 400 });
    }
    console.error(JSON.stringify({ operation: "lead_webhook_ingestion", code: "INGESTION_FAILED" }));
    return new Response(null, { status: 500 });
  }
}

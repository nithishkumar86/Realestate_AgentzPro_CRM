import { handleRazorpayWebhook } from "@/lib/server/billing-webhook-service";
import { verifyRazorpayWebhookSignature } from "@/lib/server/webhook-security";

export const runtime = "nodejs";

/**
 * Razorpay webhook (Dashboard: active event `payment.captured` only).
 *
 * The raw bytes are read BEFORE any parsing: the signature is an HMAC of exactly those bytes, and a
 * parsed-then-restringified body would never match.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = Buffer.from(await request.arrayBuffer());

  try {
    if (!verifyRazorpayWebhookSignature(rawBody, request.headers.get("x-razorpay-signature"))) {
      return new Response(null, { status: 400 });
    }
  } catch {
    // Missing configuration must not look like a delivered event; a non-2xx keeps Razorpay retrying
    // until the webhook secret is configured.
    console.error(JSON.stringify({ operation: "razorpay_webhook", code: "CONFIGURATION_UNAVAILABLE" }));
    return new Response(null, { status: 500 });
  }

  try {
    const result = await handleRazorpayWebhook(rawBody.toString("utf8"), request.headers.get("x-razorpay-event-id"));
    return new Response(null, { status: result.httpStatus });
  } catch (error) {
    console.error(
      JSON.stringify({
        operation: "razorpay_webhook",
        code: "UNEXPECTED_ERROR",
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
    );
    return new Response(null, { status: 500 });
  }
}

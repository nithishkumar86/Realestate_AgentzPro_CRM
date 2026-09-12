import { MetaAuthorizationCallbackService } from "@/lib/server/meta-authorization-callback-service";
import { parseMetaSignedRequest, readSignedRequestFromBody } from "@/lib/server/meta-signed-request";

export const runtime = "nodejs";

/**
 * Meta de-authorize callback.
 *
 * Configure this URL in App Dashboard > Facebook Login > Settings > Deauthorize Callback URL.
 *
 * Meta pings it when someone removes the app from their Facebook account without ever visiting this CRM:
 * "People are able to uninstall apps via Facebook.com without interacting with the app itself. To help
 * apps detect when this has happened, we allow them to provide a de-authorize callback URL which will be
 * pinged whenever this occurs."
 * (https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow)
 *
 * Without it, an uninstall was undetectable here: tokens stayed in the database, connections kept
 * reporting "Active", and the only symptom was leads quietly ceasing.
 */
export async function POST(request: Request): Promise<Response> {
  // The signed_request signature is the only proof this came from Meta - the endpoint is public and
  // unauthenticated - so nothing is acted on until it verifies.
  let signedRequest;
  try {
    signedRequest = parseMetaSignedRequest(await readSignedRequestFromBody(request));
  } catch {
    console.error(JSON.stringify({ operation: "meta_deauthorize_callback", code: "CONFIGURATION_UNAVAILABLE" }));
    return new Response(null, { status: 403 });
  }

  if (!signedRequest) {
    return new Response(null, { status: 403 });
  }

  try {
    const disconnected = await new MetaAuthorizationCallbackService().deauthorize(signedRequest.user_id);
    console.error(JSON.stringify({ operation: "meta_deauthorize_callback", code: "CONNECTIONS_DISCONNECTED", disconnected }));
    return new Response(null, { status: 200 });
  } catch {
    // Non-200 so Meta's delivery shows the failure rather than it being lost silently.
    console.error(JSON.stringify({ operation: "meta_deauthorize_callback", code: "DEAUTHORIZATION_FAILED" }));
    return new Response(null, { status: 500 });
  }
}

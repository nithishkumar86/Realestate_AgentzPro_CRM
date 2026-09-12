import { NextResponse } from "next/server";
import { MetaAuthorizationCallbackService } from "@/lib/server/meta-authorization-callback-service";
import { parseMetaSignedRequest, readSignedRequestFromBody } from "@/lib/server/meta-signed-request";

export const runtime = "nodejs";

/**
 * Meta data deletion request callback.
 *
 * Configure this URL in App Dashboard > Settings > Basic > Data Deletion Request URL.
 *
 * Required of every app that accesses user data. Per
 * https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/
 * the callback must "Initiate the deletion of any data your app has from Facebook about the user" and
 * "Return a JSON response that contains a URL where the user can check the status of their deletion
 * request and an alphanumeric confirmation code", in the form { url, confirmation_code }.
 * "Failure to comply with these requirements may result in your callback being removed or your app being
 * disabled."
 */
export async function POST(request: Request): Promise<Response> {
  let signedRequest;
  try {
    signedRequest = parseMetaSignedRequest(await readSignedRequestFromBody(request));
  } catch {
    console.error(JSON.stringify({ operation: "meta_data_deletion_callback", code: "CONFIGURATION_UNAVAILABLE" }));
    return new Response(null, { status: 403 });
  }

  if (!signedRequest) {
    return new Response(null, { status: 403 });
  }

  try {
    const receipt = await new MetaAuthorizationCallbackService().recordDataDeletionRequest(signedRequest.user_id);
    return NextResponse.json({ url: receipt.url, confirmation_code: receipt.confirmationCode }, { status: 200 });
  } catch {
    console.error(JSON.stringify({ operation: "meta_data_deletion_callback", code: "DELETION_REQUEST_FAILED" }));
    return new Response(null, { status: 500 });
  }
}

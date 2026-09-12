import type { Metadata } from "next";
import { MetaAuthorizationCallbackService } from "@/lib/server/meta-authorization-callback-service";
import { formatDateTime } from "@/lib/date-utils";

export const metadata: Metadata = {
  title: "Facebook data deletion request",
};

export const dynamic = "force-dynamic";

/**
 * Public status page for a Facebook data deletion request.
 *
 * Meta requires the callback's JSON response to carry "a URL where the user can check the status of their
 * deletion request and an alphanumeric confirmation code", and that the link and code "give the user
 * access to a human-readable explanation of the status of their request"
 * (https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/).
 * This is that page.
 *
 * Deliberately unauthenticated and keyed only on the confirmation code: the person arriving here has
 * removed the app from Facebook and has no account in this CRM to sign in with. The code is a 128-bit
 * random value and the page reveals no personal data - only the state of the request it names - so an
 * unknown or guessed code discloses nothing.
 */
export default async function MetaDataDeletionStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const deletionRequest = code ? await new MetaAuthorizationCallbackService().findDataDeletionRequest(code) : null;

  return <main className="stack" style={{ maxWidth: "42rem", margin: "0 auto", padding: "2rem 1rem" }}>
    <h1>Facebook data deletion request</h1>

    {!deletionRequest ? <section className="panel"><div className="panel__body stack">
      <p>We could not find a deletion request for this confirmation code.</p>
      <p>Check that the full code from your Facebook settings was included in the link. If you believe this is an error, contact support with the confirmation code.</p>
    </div></section> : <section className="panel"><div className="panel__body stack">
      <p><strong>Confirmation code:</strong> {code}</p>
      <p><strong>Status:</strong> {deletionRequest.status === "completed" ? "Completed" : "Received"}</p>
      <p><strong>Requested:</strong> {formatDateTime(deletionRequest.requestedAt)}</p>
      {deletionRequest.completedAt ? <p><strong>Completed:</strong> {formatDateTime(deletionRequest.completedAt)}</p> : null}

      <h2>What was deleted</h2>
      <p>
        The Facebook access tokens this application stored for your account have been deleted, and every
        Facebook Page connection authorized with your account has been disconnected. The application no
        longer holds credentials that can read data from your Facebook account.
      </p>

      <h2>What this does not cover</h2>
      <p>
        Lead records that a Facebook Page previously delivered to a business using this CRM belong to that
        business, not to the Facebook account that authorized the connection, and are retained and deleted
        under that business&apos;s own data policy. To request deletion of those records, contact the
        business that operates the Page.
      </p>
    </div></section>}
  </main>;
}

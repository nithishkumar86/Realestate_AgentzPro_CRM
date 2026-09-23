"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { InvitationWithdrawnClient } from "@/features/auth/invitation-withdrawn-client";

const GENERIC_ERROR_MESSAGE = "This invitation link is invalid or has expired. Sign in with your email to continue.";

// Must match INVITATION_LINK_PARAM in member-invitation-service.ts, which stamps it on the link.
const INVITATION_PARAM = "invitation";

type ConfirmBody = {
  invitationId?: string;
  tokenHash?: string;
  accessToken?: string;
  refreshToken?: string;
};

type ConfirmResponse = {
  redirectTo?: string;
  error?: { code?: string; message?: string; details?: { tenantName?: unknown } };
};

type ConfirmState =
  | { status: "confirming" }
  | { status: "withdrawn"; tenantName: string }
  | { status: "error"; message: string };

/**
 * Reads what the invite email link carried: the invitation id (always stamped on by the app), and
 * whichever credential Supabase added — `?token_hash=` or the `#access_token=…&refresh_token=…`
 * fragment. When Supabase has already used up or rejected the token, only the id arrives.
 */
function readInviteLink(): ConfirmBody {
  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const body: ConfirmBody = {};

  const invitationId = query.get(INVITATION_PARAM);
  if (invitationId) {
    body.invitationId = invitationId;
  }

  const tokenHash = query.get("token_hash");
  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  if (tokenHash) {
    body.tokenHash = tokenHash;
  } else if (accessToken && refreshToken) {
    body.accessToken = accessToken;
    body.refreshToken = refreshToken;
  }

  return body;
}

export function InviteConfirmClient() {
  const router = useRouter();
  const started = useRef(false);
  const [state, setState] = useState<ConfirmState>({ status: "confirming" });

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;

    const body = readInviteLink();
    // Tokens must not stay in the address bar or browser history.
    window.history.replaceState(null, "", window.location.pathname);

    const hasAnything = Boolean(body.invitationId || body.tokenHash || body.accessToken);
    const request = hasAnything
      ? fetch("/api/auth/invite/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      : Promise.reject(new Error(GENERIC_ERROR_MESSAGE));

    void request
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as ConfirmResponse | null;
        const tenantName = payload?.error?.details?.tenantName;
        if (payload?.error?.code === "INVITATION_WITHDRAWN" && typeof tenantName === "string") {
          setState({ status: "withdrawn", tenantName });
          return;
        }
        if (!response.ok || !payload?.redirectTo) {
          setState({ status: "error", message: payload?.error?.message ?? GENERIC_ERROR_MESSAGE });
          return;
        }
        router.replace(payload.redirectTo);
        router.refresh();
      })
      .catch(() => setState({ status: "error", message: GENERIC_ERROR_MESSAGE }));
  }, [router]);

  if (state.status === "withdrawn") {
    return <InvitationWithdrawnClient tenantName={state.tenantName} />;
  }

  return (
    <div className="auth-card">
      <h1 className="auth-card__title">Accepting your invitation</h1>
      {state.status === "error" ? (
        <>
          <p className="auth-error">{state.message}</p>
          <a className="button" href="/login">Go to sign in</a>
        </>
      ) : (
        <p className="auth-card__subtitle" role="status">Signing you in…</p>
      )}
    </div>
  );
}

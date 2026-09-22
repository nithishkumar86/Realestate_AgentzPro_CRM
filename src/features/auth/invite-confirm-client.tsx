"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const GENERIC_ERROR_MESSAGE = "This invitation link is invalid or has expired. Sign in with your email to continue.";

type ConfirmBody = { tokenHash: string } | { accessToken: string; refreshToken: string };

/**
 * Reads whichever credential the invite email link carried — `?token_hash=` or the
 * `#access_token=…&refresh_token=…` fragment — and hands it to the server, which sets the session
 * cookie. The fragment is removed from the address bar straight away so the tokens do not stay in
 * browser history.
 */
function readInviteCredential(): ConfirmBody | null {
  const query = new URLSearchParams(window.location.search);
  const tokenHash = query.get("token_hash");
  if (tokenHash) {
    return { tokenHash };
  }

  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  if (accessToken && refreshToken) {
    return { accessToken, refreshToken };
  }

  return null;
}

export function InviteConfirmClient() {
  const router = useRouter();
  const started = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;

    const credential = readInviteCredential();
    window.history.replaceState(null, "", window.location.pathname);

    const request = credential
      ? fetch("/api/auth/invite/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(credential),
        })
      : Promise.reject(new Error(GENERIC_ERROR_MESSAGE));

    void request
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as { redirectTo?: string; error?: { message?: string } } | null;
        if (!response.ok || !body?.redirectTo) {
          throw new Error(body?.error?.message ?? GENERIC_ERROR_MESSAGE);
        }
        router.replace(body.redirectTo);
        router.refresh();
      })
      .catch((error: unknown) => setErrorMessage(error instanceof Error ? error.message : GENERIC_ERROR_MESSAGE));
  }, [router]);

  return (
    <div className="auth-card">
      <h1 className="auth-card__title">Accepting your invitation</h1>
      {errorMessage ? (
        <>
          <p className="auth-error">{errorMessage}</p>
          <a className="button" href="/login">Go to sign in</a>
        </>
      ) : (
        <p className="auth-card__subtitle" role="status">Signing you in…</p>
      )}
    </div>
  );
}

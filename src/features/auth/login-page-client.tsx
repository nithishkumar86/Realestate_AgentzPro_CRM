"use client";

import { useCallback, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { BrandLogo } from "@/components/brand-logo";
import { TurnstileWidget } from "@/features/auth/turnstile-widget";
import { resetInactivityAfterLogin } from "@/features/auth/inactivity";

type Step = "email" | "otp";

const GENERIC_SEND_MESSAGE = "If this email is eligible, a verification code has been sent.";
const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

interface OtpRequestResponse {
  message?: string;
}

interface OtpVerifyResponse {
  verified: boolean;
  blocked?: boolean;
  redirectTo?: string;
}

export function LoginPageClient({ turnstileSiteKey }: { turnstileSiteKey: string | null }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetSignal, setTurnstileResetSignal] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const requiresTurnstile = Boolean(turnstileSiteKey);

  // Stable identities: an inline arrow here would give the widget a new
  // prop on every keystroke in the email field.
  const handleTurnstileVerify = useCallback((token: string) => setTurnstileToken(token), []);
  const handleTurnstileExpire = useCallback(() => setTurnstileToken(null), []);

  /**
   * Turnstile tokens are single-use — the server redeems this one during
   * verification. Whatever the outcome, it must be discarded and a fresh
   * challenge issued, or a retry silently resubmits a spent token: the
   * server rejects it, the response stays deliberately generic, and the UI
   * advances to the code step announcing an email that was never sent.
   */
  function resetTurnstile(): void {
    setTurnstileToken(null);
    setTurnstileResetSignal((signal) => signal + 1);
  }

  async function handleRequestOtp(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/otp/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, turnstileToken: turnstileToken ?? "" }),
      });

      // The endpoint always returns the same generic response body on
      // purpose (login_system_plan.md section 6.1) — a non-2xx status
      // here means the request itself was malformed, not that the email
      // was rejected for a reason worth surfacing.
      if (!response.ok) {
        throw new Error(GENERIC_ERROR_MESSAGE);
      }

      const body = (await response.json()) as OtpRequestResponse;
      setStatusMessage(body.message ?? GENERIC_SEND_MESSAGE);
      setStep("otp");
    } catch {
      setErrorMessage(GENERIC_ERROR_MESSAGE);
    } finally {
      resetTurnstile();
      setIsSubmitting(false);
    }
  }

  async function handleVerifyOtp(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/otp/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, otp }),
      });

      const body = (await response.json().catch(() => null)) as OtpVerifyResponse | null;

      if (!response.ok || !body?.verified) {
        throw new Error(body?.blocked ? "Too many attempts. Please try again in a while." : "The code is incorrect or has expired.");
      }

      resetInactivityAfterLogin();
      router.replace(body.redirectTo ?? "/leads");
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : GENERIC_ERROR_MESSAGE);
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleUseDifferentEmail(): void {
    setStep("email");
    setEmail("");
    setOtp("");
    resetTurnstile();
    setErrorMessage(null);
    setStatusMessage(null);
  }

  return (
    <div className="auth-card">
      <div className="auth-card__brand">
        <BrandLogo />
      </div>
      <h1 className="auth-card__title">Sign in</h1>

      {step === "email" ? (
        <form className="auth-form" onSubmit={(event) => void handleRequestOtp(event)}>
          <label className="auth-field">
            <span>Email address</span>
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          {turnstileSiteKey ? (
            <TurnstileWidget
              siteKey={turnstileSiteKey}
              onVerify={handleTurnstileVerify}
              onExpire={handleTurnstileExpire}
              resetSignal={turnstileResetSignal}
            />
          ) : null}

          {errorMessage ? <p className="auth-error">{errorMessage}</p> : null}

          <button className="button" type="submit" disabled={isSubmitting || (requiresTurnstile && !turnstileToken)}>
            {isSubmitting ? "Sending…" : "Send verification code"}
          </button>
        </form>
      ) : (
        <form className="auth-form" onSubmit={(event) => void handleVerifyOtp(event)}>
          {statusMessage ? <p className="auth-status">{statusMessage}</p> : null}

          <label className="auth-field">
            <span>Verification code</span>
            <input
              type="text"
              name="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              autoFocus
              value={otp}
              onChange={(event) => setOtp(event.target.value)}
            />
          </label>

          {errorMessage ? <p className="auth-error">{errorMessage}</p> : null}

          <button className="button" type="submit" disabled={isSubmitting || otp.trim().length === 0}>
            {isSubmitting ? "Verifying…" : "Verify and sign in"}
          </button>
          <button className="button button--secondary" type="button" onClick={handleUseDifferentEmail}>
            Use a different email
          </button>
        </form>
      )}
    </div>
  );
}

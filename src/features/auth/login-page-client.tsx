"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { BrandLogo } from "@/components/brand-logo";
import { TurnstileWidget } from "@/features/auth/turnstile-widget";

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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const requiresTurnstile = Boolean(turnstileSiteKey);

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
    setTurnstileToken(null);
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

          {turnstileSiteKey ? <TurnstileWidget siteKey={turnstileSiteKey} onVerify={setTurnstileToken} onExpire={() => setTurnstileToken(null)} /> : null}

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

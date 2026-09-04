"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const GENERIC_ERROR_MESSAGE = "Onboarding could not be completed. Please check your details and try again.";

interface OnboardingErrorBody {
  error?: { message?: string };
}

export function OnboardingFormClient() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [professionalRole, setProfessionalRole] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullName, phoneNumber, companyName, professionalRole }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as OnboardingErrorBody | null;
        throw new Error(body?.error?.message ?? GENERIC_ERROR_MESSAGE);
      }

      router.replace("/leads");
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : GENERIC_ERROR_MESSAGE);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-card">
      <h1 className="auth-card__title">Set up your CRM</h1>
      <p className="auth-card__subtitle">Tell us a bit about you and your company to get started.</p>

      <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
        <label className="auth-field">
          <span>Full name</span>
          <input type="text" name="fullName" required autoComplete="name" autoFocus value={fullName} onChange={(event) => setFullName(event.target.value)} />
        </label>

        <label className="auth-field">
          <span>Phone number</span>
          <input type="tel" name="phoneNumber" required autoComplete="tel" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} />
        </label>

        <label className="auth-field">
          <span>Company name</span>
          <input type="text" name="companyName" required autoComplete="organization" value={companyName} onChange={(event) => setCompanyName(event.target.value)} />
        </label>

        <label className="auth-field">
          <span>Professional role</span>
          <input
            type="text"
            name="professionalRole"
            required
            placeholder="e.g. Real Estate Agent"
            value={professionalRole}
            onChange={(event) => setProfessionalRole(event.target.value)}
          />
        </label>

        {errorMessage ? <p className="auth-error">{errorMessage}</p> : null}

        <button className="button" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Setting up…" : "Complete setup"}
        </button>
      </form>
    </div>
  );
}

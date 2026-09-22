"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const GENERIC_ERROR_MESSAGE = "Setup could not be completed. Please check your details and try again.";

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  employee: "Employee",
};

interface OnboardingErrorBody {
  error?: { message?: string };
}

export interface InvitationOnboardingFormClientProps {
  tenantName: string;
  role: string;
}

/**
 * Setup for a person invited into an existing company. They join that company's tenant with the
 * role the owner assigned, so the company and role are shown read-only and never submitted.
 */
export function InvitationOnboardingFormClient({ tenantName, role }: Readonly<InvitationOnboardingFormClientProps>) {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [professionalRole, setProfessionalRole] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/onboarding/invitation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullName, phoneNumber, professionalRole }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as OnboardingErrorBody | null;
        throw new Error(body?.error?.message ?? GENERIC_ERROR_MESSAGE);
      }

      router.replace("/");
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : GENERIC_ERROR_MESSAGE);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-card">
      <h1 className="auth-card__title">Join {tenantName}</h1>
      <p className="auth-card__subtitle">
        You have been invited as {ROLE_LABELS[role] ?? role}. Tell us a bit about you to finish setting up.
      </p>

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
          <input type="text" name="companyName" value={tenantName} readOnly disabled />
        </label>

        <label className="auth-field">
          <span>Professional role</span>
          <input
            type="text"
            name="professionalRole"
            required
            placeholder="e.g. Sales Executive"
            value={professionalRole}
            onChange={(event) => setProfessionalRole(event.target.value)}
          />
        </label>

        {errorMessage ? <p className="auth-error">{errorMessage}</p> : null}

        <button className="button" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Joining…" : "Complete setup"}
        </button>
      </form>
    </div>
  );
}

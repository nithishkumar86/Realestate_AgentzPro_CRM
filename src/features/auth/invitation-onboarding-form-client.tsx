"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AccountField, useAccountDetailsForm } from "@/features/auth/account-details-form";
import { FULL_NAME_MAX, PROFESSIONAL_ROLE_MAX } from "@/lib/account-details";

const GENERIC_ERROR_MESSAGE = "Your account could not be created. Please check your details and try again.";

// The company is fixed by the invitation, so it is shown but never validated or sent.
const FIELDS = ["fullName", "phoneNumber", "professionalRole"] as const;

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  employee: "Employee",
};

interface OnboardingErrorBody {
  error?: { message?: string; details?: { fieldErrors?: unknown } };
}

export interface InvitationOnboardingFormClientProps {
  invitationId: string;
  tenantName: string;
  role: string;
}

/**
 * Setup for a person invited into an existing company. They join that company's tenant with the
 * role the owner assigned, so the company and role are shown read-only and never submitted.
 */
export function InvitationOnboardingFormClient({ invitationId, tenantName, role }: Readonly<InvitationOnboardingFormClientProps>) {
  const router = useRouter();
  const form = useAccountDetailsForm(FIELDS);
  const { values, errors } = form;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    if (!form.validateAll()) {
      return;
    }
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/onboarding/invitation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // A person can hold invitations from several companies; this names the one on screen.
          invitationId,
          fullName: values.fullName,
          phoneNumber: values.phoneNumber,
          professionalRole: values.professionalRole,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as OnboardingErrorBody | null;
        if (form.applyServerErrors(body?.error?.details?.fieldErrors)) {
          return;
        }
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

      <form className="auth-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
        <AccountField
          name="fullName"
          label="Full name"
          type="text"
          autoComplete="name"
          autoFocus
          maxLength={FULL_NAME_MAX}
          value={values.fullName}
          error={errors.fullName}
          onValueChange={form.change}
          onFieldBlur={form.blur}
        />

        <AccountField
          name="phoneNumber"
          label="Mobile number"
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          prefix="+91"
          placeholder="9876543210"
          value={values.phoneNumber}
          error={errors.phoneNumber}
          onValueChange={form.change}
          onFieldBlur={form.blur}
        />

        <label className="auth-field">
          <span>Company name</span>
          <input type="text" name="companyName" value={tenantName} readOnly disabled />
        </label>

        <AccountField
          name="professionalRole"
          label="Professional role"
          type="text"
          placeholder="e.g. Sales Executive"
          maxLength={PROFESSIONAL_ROLE_MAX}
          value={values.professionalRole}
          error={errors.professionalRole}
          onValueChange={form.change}
          onFieldBlur={form.blur}
        />

        {errorMessage ? <p className="auth-error">{errorMessage}</p> : null}

        <button className="button" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating account…" : "Create account"}
        </button>
      </form>
    </div>
  );
}

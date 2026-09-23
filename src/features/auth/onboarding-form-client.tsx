"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AccountField, useAccountDetailsForm } from "@/features/auth/account-details-form";
import { COMPANY_NAME_MAX, FULL_NAME_MAX, PROFESSIONAL_ROLE_MAX } from "@/lib/account-details";

const GENERIC_ERROR_MESSAGE = "Your account could not be created. Please check your details and try again.";

interface OnboardingErrorBody {
  error?: { message?: string; details?: { fieldErrors?: unknown } };
}

/**
 * The tenant's timezone decides what "Today's Leads" means and how every lead date reads, so it
 * has to be recorded at signup — a tenant left on the stored 'UTC' default cannot load leads at
 * all. The browser already knows it, so it is read here instead of being asked for: one less
 * field to fill in, and right on the first try for anyone not travelling. Returns undefined when
 * the environment has no resolvable zone; the server then falls back on its own.
 */
function detectTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

const FIELDS = ["fullName", "phoneNumber", "companyName", "professionalRole"] as const;

export function OnboardingFormClient() {
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
      const response = await fetch("/api/auth/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullName: values.fullName,
          phoneNumber: values.phoneNumber,
          companyName: values.companyName,
          professionalRole: values.professionalRole,
          timezone: detectTimezone(),
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
      <h1 className="auth-card__title">Set up your CRM</h1>
      <p className="auth-card__subtitle">Tell us a bit about you and your company to get started.</p>

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

        <AccountField
          name="companyName"
          label="Company name"
          type="text"
          autoComplete="organization"
          maxLength={COMPANY_NAME_MAX}
          value={values.companyName}
          error={errors.companyName}
          onValueChange={form.change}
          onFieldBlur={form.blur}
        />

        <AccountField
          name="professionalRole"
          label="Professional role"
          type="text"
          placeholder="e.g. Real Estate Agent"
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

/**
 * Validation for the "Create account" step: both the owner form and the invited-member form.
 * Shared by the browser (inline field errors) and the server (the authoritative check before
 * any RPC), so the two can never disagree about what is acceptable.
 */

export type AccountDetailsField = "fullName" | "phoneNumber" | "companyName" | "professionalRole";

export type AccountDetailsErrors = Partial<Record<AccountDetailsField, string>>;

export interface AccountDetailsInput {
  fullName: string;
  phoneNumber: string;
  professionalRole: string;
  /** Omitted for invited members: they join an existing company and never name one. */
  companyName?: string;
}

export interface AccountDetails {
  fullName: string;
  /** Stored form: "91" followed by the 10-digit mobile number. */
  phoneNumber: string;
  professionalRole: string;
  companyName?: string;
}

export type AccountDetailsResult =
  | { ok: true; values: AccountDetails }
  | { ok: false; errors: AccountDetailsErrors };

export const FULL_NAME_MAX = 60;
export const COMPANY_NAME_MAX = 100;
export const PROFESSIONAL_ROLE_MAX = 60;
/** Every account phone is Indian: the +91 is fixed in the form, the person types the 10 digits. */
export const PHONE_COUNTRY_CODE = "91";
export const PHONE_DIGITS = 10;

const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;
const COMPANY_PATTERN = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} &.,'()/@+-]*$/u;
const ROLE_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} &.,'()/-]*$/u;
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

function tidy(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function countLetters(value: string): number {
  return (value.match(/\p{L}/gu) ?? []).length;
}

function checkFullName(value: string): string | null {
  if (!value) return "Enter your full name.";
  if (value.length < 2 || value.length > FULL_NAME_MAX) return `Full name must be 2 to ${FULL_NAME_MAX} characters.`;
  if (!NAME_PATTERN.test(value) || countLetters(value) < 2) {
    return "Full name can contain only letters, spaces, dots, apostrophes and hyphens.";
  }
  return null;
}

function checkCompanyName(value: string): string | null {
  if (!value) return "Enter your company name.";
  if (value.length < 2 || value.length > COMPANY_NAME_MAX) return `Company name must be 2 to ${COMPANY_NAME_MAX} characters.`;
  if (!COMPANY_PATTERN.test(value) || countLetters(value) < 1) {
    return "Company name can contain letters, numbers, spaces and & . , ' ( ) / @ + -";
  }
  return null;
}

function checkProfessionalRole(value: string): string | null {
  if (!value) return "Enter your professional role.";
  if (value.length < 2 || value.length > PROFESSIONAL_ROLE_MAX) {
    return `Professional role must be 2 to ${PROFESSIONAL_ROLE_MAX} characters.`;
  }
  if (!ROLE_PATTERN.test(value) || countLetters(value) < 2) {
    return "Professional role can contain only letters, spaces and & . , ' ( ) / -";
  }
  return null;
}

/**
 * The country code is fixed at +91 and shown beside the box, so the person enters exactly the
 * 10-digit mobile number — digits only, starting 6–9. Anything else is rejected, never guessed at.
 * Returns the stored form, "91" + the 10 digits.
 */
export function parseIndianMobile(raw: string): string | null {
  const value = raw.trim();
  return INDIAN_MOBILE.test(value) ? `${PHONE_COUNTRY_CODE}${value}` : null;
}

/**
 * Keeps the phone box to digits only and at most 10 of them as the person types. A pasted number
 * that still carries the country code ("+91 98765 43210") or a trunk 0 ("098765 43210") has that
 * prefix dropped first, so the paste lands as the 10-digit number rather than being cut short.
 */
export function sanitizePhoneInput(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.length > PHONE_DIGITS && digits.startsWith(PHONE_COUNTRY_CODE)) digits = digits.slice(PHONE_COUNTRY_CODE.length);
  else if (digits.length > PHONE_DIGITS && digits.startsWith("0")) digits = digits.slice(1);
  return digits.slice(0, PHONE_DIGITS);
}

function checkPhoneNumber(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Enter your mobile number.";
  if (!/^\d+$/.test(value)) return "Mobile number can contain digits only.";
  if (value.length !== PHONE_DIGITS) return "Mobile number must be exactly 10 digits.";
  return parseIndianMobile(value) ? null : "Enter a valid Indian mobile number starting with 6, 7, 8 or 9.";
}

/** Validates one field as the person types or leaves it; returns the message to show, or null. */
export function validateAccountField(field: AccountDetailsField, raw: string): string | null {
  switch (field) {
    case "fullName":
      return checkFullName(tidy(raw));
    case "phoneNumber":
      return checkPhoneNumber(raw);
    case "companyName":
      return checkCompanyName(tidy(raw));
    case "professionalRole":
      return checkProfessionalRole(tidy(raw));
  }
}

export function validateAccountDetails(input: AccountDetailsInput): AccountDetailsResult {
  const fields: AccountDetailsField[] = ["fullName", "phoneNumber", "professionalRole"];
  if (input.companyName !== undefined) fields.splice(2, 0, "companyName");

  const errors: AccountDetailsErrors = {};
  for (const field of fields) {
    const message = validateAccountField(field, input[field] ?? "");
    if (message) errors[field] = message;
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const values: AccountDetails = {
    fullName: tidy(input.fullName),
    phoneNumber: parseIndianMobile(input.phoneNumber) as string,
    professionalRole: tidy(input.professionalRole),
  };
  if (input.companyName !== undefined) values.companyName = tidy(input.companyName);
  return { ok: true, values };
}

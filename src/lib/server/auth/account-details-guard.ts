import "server-only";

import { validateAccountDetails, type AccountDetails, type AccountDetailsInput } from "@/lib/account-details";
import { AppError } from "@/lib/server/app-error";

/**
 * The server's authoritative check on "Create account" details. Returns the cleaned values, or
 * throws a 400 whose message is the first problem and whose details.fieldErrors lets the form put
 * every message under its own field. A phone-only failure keeps its own INVALID_PHONE_NUMBER code.
 */
export function requireValidAccountDetails(input: AccountDetailsInput): AccountDetails {
  const result = validateAccountDetails(input);
  if (result.ok) {
    return result.values;
  }

  const messages = Object.values(result.errors);
  const phoneOnly = messages.length === 1 && result.errors.phoneNumber !== undefined;
  throw new AppError(messages[0] ?? "Account details are invalid.", {
    status: 400,
    code: phoneOnly ? "INVALID_PHONE_NUMBER" : "INVALID_ONBOARDING_INPUT",
    details: { fieldErrors: result.errors },
  });
}

import "server-only";

import { z } from "zod";
import { validateAccountField, parseIndianMobile, type AccountDetailsErrors } from "@/lib/account-details";
import { AppError } from "@/lib/server/app-error";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { createAuthClient } from "@/lib/server/auth/supabase-auth-client";
import { getCurrentProfileDetails, type CurrentProfileDetails } from "@/lib/server/profile-query-service";

/**
 * Only the name, the phone number and the professional role are editable from Profile. Company is
 * deliberately absent: `.strict()` rejects any other key, so it can never ride along in a request.
 */
const profileUpdateSchema = z
  .object({
    fullName: z.string().max(200).optional(),
    // The 10-digit mobile number as typed; the +91 is fixed in the form, as at onboarding.
    phoneNumber: z.string().max(20).optional(),
    professionalRole: z.string().max(200).optional(),
  })
  .strict()
  .refine((value) => value.fullName !== undefined || value.phoneNumber !== undefined || value.professionalRole !== undefined, {
    message: "Nothing to update.",
  });

export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

/**
 * Updates the signed-in person's own name, phone and/or professional role, using the same rules as
 * account creation, then returns the refreshed five Profile values.
 *
 * The write uses the request's authenticated Supabase client, so the existing profiles_update_own
 * RLS policy and the column-level update grant (full_name, phone_number, professional_role) remain
 * the database boundary in addition to the explicit user_id filter.
 */
export async function updateCurrentProfile(input: unknown): Promise<CurrentProfileDetails> {
  const parsed = profileUpdateSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("Only your name, phone number and professional role can be changed.", { status: 400, code: "INVALID_PROFILE_UPDATE" });
  }

  const errors: AccountDetailsErrors = {};
  const changes: { full_name?: string; phone_number?: string; professional_role?: string } = {};

  if (parsed.data.fullName !== undefined) {
    const message = validateAccountField("fullName", parsed.data.fullName);
    if (message) errors.fullName = message;
    else changes.full_name = parsed.data.fullName.normalize("NFC").replace(/\s+/g, " ").trim();
  }
  if (parsed.data.phoneNumber !== undefined) {
    const message = validateAccountField("phoneNumber", parsed.data.phoneNumber);
    if (message) errors.phoneNumber = message;
    else changes.phone_number = parseIndianMobile(parsed.data.phoneNumber) as string;
  }
  if (parsed.data.professionalRole !== undefined) {
    const message = validateAccountField("professionalRole", parsed.data.professionalRole);
    if (message) errors.professionalRole = message;
    else changes.professional_role = parsed.data.professionalRole.normalize("NFC").replace(/\s+/g, " ").trim();
  }

  const messages = Object.values(errors);
  if (messages.length > 0) {
    throw new AppError(messages[0] ?? "Profile details are invalid.", {
      status: 400,
      code: "INVALID_PROFILE_UPDATE",
      details: { fieldErrors: errors },
    });
  }

  const access = await requireCrmAccess();
  const supabase = await createAuthClient();
  const { data, error } = await supabase
    .from("profiles")
    .update(changes)
    .eq("user_id", access.userId)
    .select("user_id")
    .maybeSingle();

  if (error || !data) {
    throw new AppError("Your profile could not be saved.", {
      status: 500,
      code: "PROFILE_UPDATE_FAILED",
      retryable: true,
    });
  }

  return getCurrentProfileDetails();
}

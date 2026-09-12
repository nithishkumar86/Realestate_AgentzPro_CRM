import "server-only";

import { AppError } from "@/lib/server/app-error";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { createAuthClient } from "@/lib/server/auth/supabase-auth-client";

export interface CurrentProfileDetails {
  fullName: string;
  phoneNumber: string;
  emailAddress: string;
  companyName: string;
  professionalRole: string;
}

type ProfileRow = {
  user_id: string;
  full_name: string;
  phone_number: string;
  professional_role: string;
};

/**
 * Loads the five read-only values shown by the Profile dialog.
 *
 * The existing CRM access resolver remains the authority for the signed-in
 * user and tenant. The profile query uses the request's authenticated
 * Supabase client, so the existing profiles_select_own RLS policy remains a
 * second boundary in addition to the explicit user_id filter.
 */
export async function getCurrentProfileDetails(): Promise<CurrentProfileDetails> {
  const access = await requireCrmAccess();
  const supabase = await createAuthClient();

  const [userResult, profileResult] = await Promise.all([
    supabase.auth.getUser(),
    supabase
      .from("profiles")
      .select("user_id,full_name,phone_number,professional_role")
      .eq("user_id", access.userId)
      .maybeSingle(),
  ]);

  const authenticatedUser = userResult.data.user;
  if (userResult.error || !authenticatedUser || authenticatedUser.id !== access.userId) {
    throw new AppError("Your profile could not be authenticated.", {
      status: 401,
      code: "PROFILE_AUTHENTICATION_FAILED",
    });
  }

  if (profileResult.error) {
    throw new AppError("Your profile could not be loaded.", {
      status: 500,
      code: "PROFILE_LOAD_FAILED",
      retryable: true,
    });
  }

  const profile = profileResult.data as ProfileRow | null;
  const emailAddress = authenticatedUser.email?.trim();
  if (!profile || profile.user_id !== access.userId || !emailAddress) {
    throw new AppError("Your profile is incomplete.", {
      status: 500,
      code: "PROFILE_INCOMPLETE",
    });
  }

  return {
    fullName: profile.full_name,
    phoneNumber: profile.phone_number,
    emailAddress,
    companyName: access.tenantName,
    professionalRole: profile.professional_role,
  };
}

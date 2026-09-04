import { redirect } from "next/navigation";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { isAppError } from "@/lib/server/app-error";

/**
 * Login-state-aware landing redirect (replaces the previous unconditional
 * redirect("/leads")). Mirrors the (crm) layout guard's routing so a
 * direct visit to "/" lands on the correct destination in one hop instead
 * of bouncing through /leads first.
 */
export default async function HomePage() {
  try {
    await requireCrmAccess();
  } catch (error) {
    if (isAppError(error)) {
      if (error.code === "UNAUTHENTICATED") {
        redirect("/login");
      }
      if (error.code === "ONBOARDING_REQUIRED") {
        redirect("/onboarding");
      }
      if (error.code === "CRM_ACCESS_DENIED" || error.code === "ACCOUNT_INTEGRITY_ERROR") {
        redirect("/billing");
      }
    }
    throw error;
  }

  redirect("/leads");
}

import { redirect } from "next/navigation";
import { CrmShell } from "@/components/crm-shell";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { isAppError } from "@/lib/server/app-error";

/**
 * Server-verified guard for every page under the (crm) route group
 * (login_system_plan.md section 6.6: "Re-evaluate authorization on
 * protected requests; never rely only on a dashboard redirect."). This
 * runs requireCrmAccess() on every request to this layout, independent of
 * src/proxy.ts's own optimistic session check, and never renders CrmShell
 * unless access is currently valid.
 *
 * ONBOARDING_REQUIRED routes to /onboarding. UNAUTHENTICATED routes to
 * /login (a defence-in-depth backstop — src/proxy.ts already redirects an
 * unauthenticated request away from these paths before it reaches here).
 * CRM_ACCESS_DENIED and ACCOUNT_INTEGRITY_ERROR both route to /billing,
 * which independently resolves the login state itself to distinguish an
 * expired subscription from a genuine data-integrity issue in what it
 * displays — this layout does not need to make that distinction.
 */
export default async function CrmLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  let access;
  try {
    access = await requireCrmAccess();
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
    // An unrecognized AppError code, or a non-AppError failure, is a real
    // bug to surface — never silently route it to /login as if it were an
    // ordinary authentication failure.
    throw error;
  }

  return (
    <CrmShell fullName={access.fullName} tenantName={access.tenantName}>
      {children}
    </CrmShell>
  );
}

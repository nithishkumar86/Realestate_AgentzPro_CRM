import { SignedInInactivityLogout } from "@/features/auth/inactivity-logout";

/**
 * Deliberately outside the (crm) route group so CrmShell's sidebar/header
 * never renders on the login, onboarding, or billing pages. The signed-in
 * pages here still get the same eight-hour idle logout as the CRM.
 */
export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="auth-shell">
      <SignedInInactivityLogout />
      {children}
    </div>
  );
}

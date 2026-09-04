/**
 * Deliberately outside the (crm) route group so CrmShell's sidebar/header
 * never renders on the login, onboarding, or billing pages.
 */
export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="auth-shell">{children}</div>;
}

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { WorkspacePickerClient } from "@/features/workspaces/workspace-picker-client";
import { readActiveTenantHint } from "@/lib/server/auth/active-tenant";
import { resolveLoginState } from "@/lib/server/auth/login-state";
import { verifySession } from "@/lib/server/auth/session";
import { listUserWorkspaces } from "@/lib/server/workspace-service";

export const metadata: Metadata = {
  title: "Your companies",
};

/**
 * One login, many companies: pick the company to work in, answer invitations from other companies,
 * or create your own. Only someone with a profile gets here; a first-time user is sent to
 * /onboarding, which still owns the one-time personal-details form.
 */
export default async function WorkspacesPage() {
  const session = await verifySession();
  if (!session) {
    redirect("/login");
  }

  const activeTenantHint = await readActiveTenantHint();
  const state = await resolveLoginState(session.userId, activeTenantHint);

  if (state.status === "needs_onboarding") {
    redirect("/onboarding");
  }
  if (state.status === "integrity_error") {
    redirect("/billing");
  }

  const workspaces = await listUserWorkspaces(session.userId);
  const activeTenantId = state.status === "ready" ? state.tenantId : activeTenantHint;

  return <WorkspacePickerClient workspaces={workspaces} activeTenantId={activeTenantId} />;
}

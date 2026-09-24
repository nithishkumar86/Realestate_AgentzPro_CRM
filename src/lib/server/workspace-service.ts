import "server-only";

import { z } from "zod";
import { validateAccountField } from "@/lib/account-details";
import { AppError } from "@/lib/server/app-error";
import { createAuthClient } from "@/lib/server/auth/supabase-auth-client";
import { listPendingInvitationsForUser, type PendingInvitationForUser } from "@/lib/server/member-invitation-service";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * Workspaces = the companies one person belongs to (supabase/migrations/20260924120000_multi_membership.sql).
 * One login, one profile, many tenant_memberships rows. Every function here is scoped to the
 * caller's own user id, which always comes from a verified session, never from a request body.
 */

export interface UserCompany {
  tenantId: string;
  tenantName: string;
  role: string;
  membershipStatus: string;
}

export interface UserWorkspaces {
  companies: UserCompany[];
  invitations: PendingInvitationForUser[];
  /** At most one owned company per person, so "Create new company" is offered only when false. */
  ownsCompany: boolean;
}

interface MembershipRow {
  tenant_id: string;
  membership_role: string;
  membership_status: string;
}

export async function listUserWorkspaces(userId: string): Promise<UserWorkspaces> {
  const db = getSupabaseAdminClient();

  const [membershipsResult, invitations] = await Promise.all([
    db.from("tenant_memberships").select("tenant_id,membership_role,membership_status").eq("user_id", userId),
    listPendingInvitationsForUser(userId),
  ]);

  if (membershipsResult.error) {
    throw new AppError("Your companies could not be loaded.", { status: 500, code: "WORKSPACES_LOAD_FAILED", retryable: true });
  }

  const memberships = (membershipsResult.data ?? []) as MembershipRow[];
  let names = new Map<string, string>();

  if (memberships.length > 0) {
    const { data: tenants, error } = await db
      .from("tenants")
      .select("tenant_id,tenant_name")
      .in("tenant_id", memberships.map((row) => row.tenant_id));
    if (error) {
      throw new AppError("Your companies could not be loaded.", { status: 500, code: "WORKSPACES_LOAD_FAILED", retryable: true });
    }
    names = new Map(((tenants ?? []) as { tenant_id: string; tenant_name: string }[]).map((t) => [t.tenant_id, t.tenant_name]));
  }

  const companies = memberships
    .filter((row) => names.has(row.tenant_id))
    .map((row) => ({
      tenantId: row.tenant_id,
      tenantName: names.get(row.tenant_id) as string,
      role: row.membership_role,
      membershipStatus: row.membership_status,
    }))
    .sort((a, b) => a.tenantName.localeCompare(b.tenantName));

  return {
    companies,
    invitations,
    ownsCompany: memberships.some((row) => row.membership_role === "owner"),
  };
}

/**
 * Confirms the caller really is an active member of `tenantId` before it becomes their active
 * company. The id arrives from the browser, so this lookup is what stops one company's employee
 * from switching into a company they do not belong to.
 */
export async function requireActiveMembership(userId: string, tenantId: string): Promise<void> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tenant_memberships")
    .select("tenant_id")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId)
    .eq("membership_status", "active")
    .maybeSingle();

  if (error) {
    throw new AppError("Your company could not be opened.", { status: 500, code: "WORKSPACE_SWITCH_FAILED", retryable: true });
  }
  if (!data) {
    throw new AppError("You are not a member of this company.", { status: 404, code: "WORKSPACE_NOT_FOUND" });
  }
}

const createWorkspaceSchema = z.object({
  companyName: z.string().max(200),
  // Same handling as owner onboarding: optional, never trusted, validated by the RPC.
  timezone: z.string().trim().max(64).optional(),
});

export interface CreatedWorkspace {
  tenantId: string;
}

/**
 * "Create new company" for someone who already has a profile. Only the company name is asked;
 * their name, phone, and job title are reused. The RPC returns the caller's existing owned company
 * instead of a second one, so a double-click or a retry is safe.
 */
export async function createOwnedWorkspace(rawInput: unknown): Promise<CreatedWorkspace> {
  const parsed = createWorkspaceSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError("Company details are invalid.", { status: 400, code: "INVALID_WORKSPACE_INPUT" });
  }

  const companyNameError = validateAccountField("companyName", parsed.data.companyName);
  if (companyNameError) {
    throw new AppError(companyNameError, {
      status: 400,
      code: "INVALID_WORKSPACE_INPUT",
      details: { fieldErrors: { companyName: companyNameError } },
    });
  }
  const companyName = parsed.data.companyName.normalize("NFC").replace(/\s+/g, " ").trim();

  const supabase = await createAuthClient();
  const { data, error } = await supabase.rpc("create_owned_workspace", {
    p_tenant_name: companyName,
    p_timezone: parsed.data.timezone ?? null,
  });

  if (error) {
    if (error.code === "P0001") {
      throw new AppError("Complete your account setup first.", { status: 409, code: "ONBOARDING_REQUIRED" });
    }
    throw new AppError("The company could not be created.", { status: 500, code: "WORKSPACE_CREATE_FAILED", retryable: true });
  }

  const row: { tenant_id: string } | undefined = Array.isArray(data) ? data[0] : data;
  if (!row?.tenant_id) {
    throw new AppError("The company could not be created.", { status: 500, code: "WORKSPACE_CREATE_FAILED", retryable: true });
  }

  return { tenantId: row.tenant_id };
}

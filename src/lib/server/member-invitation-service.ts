import "server-only";

import { z } from "zod";
import { AppError } from "@/lib/server/app-error";
import type { CrmAccessGranted } from "@/lib/server/auth/access";
import { requireValidAccountDetails } from "@/lib/server/auth/account-details-guard";
import { createAuthClient } from "@/lib/server/auth/supabase-auth-client";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * Member invitation pipeline (supabase/migrations/20260922120000_invitation_member.sql).
 *
 * An owner invites people into THEIR tenant. The invitee later joins that same tenant with the
 * role the owner chose — they never create a tenant and are never asked for a role. The tenant and
 * inviter always come from the owner's verified session (CrmAccessGranted), never from the body.
 */

export type InvitableRole = "admin" | "employee";

export const MAX_INVITATIONS_PER_REQUEST = 10;

/** Query parameter on the invite email's /auth/confirm link that carries the invitation id. */
export const INVITATION_LINK_PARAM = "invitation";

const sendInvitationsSchema = z.object({
  invitations: z
    .array(
      z.object({
        email: z.string().trim().min(1).max(320),
        role: z.enum(["admin", "employee"]),
      }),
    )
    .min(1)
    .max(MAX_INVITATIONS_PER_REQUEST),
});

export type InvitationSendStatus =
  | "sent"
  | "saved_existing_account"
  | "already_member"
  | "already_invited"
  | "invalid_email"
  | "failed";

export interface InvitationSendResult {
  email: string;
  status: InvitationSendStatus;
  message: string;
}

const RESULT_MESSAGES: Record<InvitationSendStatus, string> = {
  sent: "Invitation sent.",
  saved_existing_account: "This person already has an account. They will be asked to join when they next sign in.",
  already_member: "This person already belongs to an organization.",
  already_invited: "This person already has a pending invitation.",
  invalid_email: "Enter a valid email address.",
  failed: "The invitation email could not be sent. Please try again.",
};

type CreateInvitationOutcome = "CREATED" | "INVALID_EMAIL" | "INVALID_ROLE" | "NOT_OWNER" | "ALREADY_MEMBER" | "ALREADY_INVITED";

interface CreateInvitationRow {
  outcome: CreateInvitationOutcome;
  invitation_id: string | null;
  user_id: string | null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function logInvitationEvent(reason: string, extra: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ operation: "member_invitation", reason, ...extra }));
}

function result(email: string, status: InvitationSendStatus): InvitationSendResult {
  return { email, status, message: RESULT_MESSAGES[status] };
}

/**
 * Records each invitation and sends the invite email. `redirectTo` is this deployment's own
 * /auth/confirm URL; it must be in the Supabase Auth redirect allow-list.
 */
export async function sendMemberInvitations(
  access: CrmAccessGranted,
  rawInput: unknown,
  redirectTo: string,
): Promise<InvitationSendResult[]> {
  if (access.membershipRole !== "owner") {
    throw new AppError("Only the owner can invite members.", { status: 403, code: "INVITE_NOT_ALLOWED" });
  }

  const parsed = sendInvitationsSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError("Invitation details are invalid.", { status: 400, code: "INVALID_INVITATION_INPUT" });
  }

  const db = getSupabaseAdminClient();
  const seen = new Set<string>();
  const results: InvitationSendResult[] = [];

  for (const invitation of parsed.data.invitations) {
    const email = invitation.email.trim().toLowerCase();

    if (!EMAIL_PATTERN.test(email)) {
      results.push(result(email, "invalid_email"));
      continue;
    }
    if (seen.has(email)) {
      results.push(result(email, "already_invited"));
      continue;
    }
    seen.add(email);

    const { data, error } = await db.rpc("create_member_invitation", {
      p_tenant_id: access.tenantId,
      p_invited_by: access.userId,
      p_email: email,
      p_membership_role: invitation.role,
    });

    const row: CreateInvitationRow | undefined = Array.isArray(data) ? data[0] : data;
    if (error || !row) {
      logInvitationEvent("CREATE_INVITATION_FAILED");
      results.push(result(email, "failed"));
      continue;
    }

    if (row.outcome === "NOT_OWNER") {
      throw new AppError("Only the owner can invite members.", { status: 403, code: "INVITE_NOT_ALLOWED" });
    }
    if (row.outcome === "ALREADY_MEMBER") {
      results.push(result(email, "already_member"));
      continue;
    }
    if (row.outcome === "ALREADY_INVITED") {
      results.push(result(email, "already_invited"));
      continue;
    }
    if (row.outcome !== "CREATED" || !row.invitation_id) {
      results.push(result(email, row.outcome === "INVALID_EMAIL" ? "invalid_email" : "failed"));
      continue;
    }

    results.push(await deliverInvitation(row.invitation_id, email, row.user_id, redirectTo));
  }

  return results;
}

async function deliverInvitation(
  invitationId: string,
  email: string,
  existingUserId: string | null,
  redirectTo: string,
): Promise<InvitationSendResult> {
  const db = getSupabaseAdminClient();
  // The invitation id rides on the link so /auth/confirm can say "withdrawn" even after Supabase's
  // one-time token is used up or rejected — the id is the only thing that survives that redirect.
  const link = new URL(redirectTo);
  link.searchParams.set(INVITATION_LINK_PARAM, invitationId);
  const { data, error } = await db.auth.admin.inviteUserByEmail(email, { redirectTo: link.toString() });

  if (!error && data.user) {
    // inviteUserByEmail creates the auth.users row; that id is the invitee's user_id from now on.
    const { error: updateError } = await db
      .from("invitation_member")
      .update({ user_id: data.user.id })
      .eq("invitation_id", invitationId);
    if (updateError) {
      // The accept step can still match on the session's verified email, so this is not fatal.
      logInvitationEvent("INVITATION_USER_ID_WRITE_FAILED");
    }
    return result(email, "sent");
  }

  if (existingUserId && error?.code === "email_exists") {
    // A confirmed account that never finished setup. The invitation stays pending and is offered
    // on their next sign-in; Supabase will not send an invite email to a confirmed address.
    return result(email, "saved_existing_account");
  }

  logInvitationEvent("INVITE_EMAIL_FAILED", { providerStatus: error?.status, providerCode: error?.code });
  const { error: deleteError } = await db.from("invitation_member").delete().eq("invitation_id", invitationId);
  if (deleteError) {
    logInvitationEvent("INVITATION_ROLLBACK_FAILED");
  }
  return result(email, "failed");
}

/**
 * Owner-only: withdraws one of the caller's own pending invitations by marking it 'revoked'.
 * Scoped to the caller's tenant so an owner can never touch another tenant's invitation, and to
 * status = 'pending' so an already-accepted/expired/revoked row is left untouched.
 */
export async function cancelMemberInvitation(access: CrmAccessGranted, invitationId: string): Promise<void> {
  if (access.membershipRole !== "owner") {
    throw new AppError("Only the owner can remove invitations.", { status: 403, code: "INVITE_NOT_ALLOWED" });
  }

  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from("invitation_member")
    .update({ status: "revoked" })
    .eq("invitation_id", invitationId)
    .eq("tenant_id", access.tenantId)
    .eq("status", "pending")
    .select("invitation_id")
    .maybeSingle();

  if (error) {
    throw new AppError("The invitation could not be removed.", { status: 500, code: "INVITATION_CANCEL_FAILED", retryable: true });
  }
  if (!data) {
    throw new AppError("This invitation is no longer pending.", { status: 404, code: "INVITATION_NOT_FOUND" });
  }
}

// ---------------------------------------------------------------------------
// Members list
// ---------------------------------------------------------------------------

export interface TenantMember {
  userId: string;
  fullName: string;
  email: string;
  role: "owner" | "admin" | "employee";
  status: string;
  joinedAt: string;
}

export interface PendingInvitation {
  invitationId: string;
  email: string;
  role: InvitableRole;
  invitedAt: string;
  expiresAt: string;
}

export interface TenantMembersOverview {
  currentUserId: string;
  canInvite: boolean;
  members: TenantMember[];
  invitations: PendingInvitation[];
}

interface MemberRow {
  user_id: string;
  full_name: string;
  email: string;
  membership_role: TenantMember["role"];
  membership_status: string;
  joined_at: string;
}

interface InvitationRow {
  invitation_id: string;
  email: string;
  membership_role: InvitableRole;
  created_at: string;
  expires_at: string;
}

export async function listTenantMembers(access: CrmAccessGranted): Promise<TenantMembersOverview> {
  const db = getSupabaseAdminClient();

  const [membersResult, invitationsResult] = await Promise.all([
    db.rpc("list_tenant_members", { p_tenant_id: access.tenantId }),
    db
      .from("invitation_member")
      .select("invitation_id,email,membership_role,created_at,expires_at")
      .eq("tenant_id", access.tenantId)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false }),
  ]);

  if (membersResult.error || invitationsResult.error) {
    throw new AppError("Members could not be loaded.", { status: 500, code: "MEMBERS_LOAD_FAILED", retryable: true });
  }

  const members = ((membersResult.data ?? []) as MemberRow[]).map((row) => ({
    userId: row.user_id,
    fullName: row.full_name,
    email: row.email,
    role: row.membership_role,
    status: row.membership_status,
    joinedAt: row.joined_at,
  }));

  const invitations = ((invitationsResult.data ?? []) as InvitationRow[]).map((row) => ({
    invitationId: row.invitation_id,
    email: row.email,
    role: row.membership_role,
    invitedAt: row.created_at,
    expiresAt: row.expires_at,
  }));

  return { currentUserId: access.userId, canInvite: access.membershipRole === "owner", members, invitations };
}

// ---------------------------------------------------------------------------
// Invitee side
// ---------------------------------------------------------------------------

export interface InvitationForUser {
  invitationId: string;
  tenantName: string;
  role: InvitableRole;
}

/**
 * Finds the open invitation for a signed-in user who has not completed setup: by user_id first,
 * then by their verified sign-in email for a row whose user_id was never written back.
 */
export async function findPendingInvitationForUser(userId: string): Promise<InvitationForUser | null> {
  const db = getSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  const columns = "invitation_id,tenant_id,membership_role";

  const byUser = await db
    .from("invitation_member")
    .select(columns)
    .eq("user_id", userId)
    .eq("status", "pending")
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (byUser.error) {
    throw new AppError("Invitation could not be checked.", { status: 500, code: "INVITATION_LOOKUP_FAILED", retryable: true });
  }

  let invitation = byUser.data as { invitation_id: string; tenant_id: string; membership_role: InvitableRole } | null;

  if (!invitation) {
    const { data: userData } = await db.auth.admin.getUserById(userId);
    const email = userData.user?.email?.trim().toLowerCase();
    if (email) {
      const byEmail = await db
        .from("invitation_member")
        .select(columns)
        .eq("email", email)
        .is("user_id", null)
        .eq("status", "pending")
        .gt("expires_at", nowIso)
        .limit(1)
        .maybeSingle();
      if (byEmail.error) {
        throw new AppError("Invitation could not be checked.", { status: 500, code: "INVITATION_LOOKUP_FAILED", retryable: true });
      }
      invitation = byEmail.data as typeof invitation;
    }
  }

  if (!invitation) {
    return null;
  }

  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("tenant_name")
    .eq("tenant_id", invitation.tenant_id)
    .maybeSingle();

  if (tenantError || !tenant) {
    throw new AppError("Invitation could not be checked.", { status: 500, code: "INVITATION_LOOKUP_FAILED", retryable: true });
  }

  return { invitationId: invitation.invitation_id, tenantName: tenant.tenant_name, role: invitation.membership_role };
}

export interface WithdrawnInvitationForUser {
  tenantName: string;
}

/**
 * Looks up the invitation an email link was issued for, by the id stamped on that link. Returns the
 * company name only when the owner withdrew it; any other state (pending, accepted, expired, or an
 * unknown id) returns null so the normal sign-in path decides. The caller holds the emailed link, so
 * revealing which company withdrew it tells them nothing they were not already sent.
 */
export async function findWithdrawnInvitationById(invitationId: string): Promise<WithdrawnInvitationForUser | null> {
  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from("invitation_member")
    .select("tenant_id")
    .eq("invitation_id", invitationId)
    .eq("status", "revoked")
    .maybeSingle();

  if (error) {
    throw new AppError("Invitation could not be checked.", { status: 500, code: "INVITATION_LOOKUP_FAILED", retryable: true });
  }
  if (!data) {
    return null;
  }

  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("tenant_name")
    .eq("tenant_id", (data as { tenant_id: string }).tenant_id)
    .maybeSingle();

  if (tenantError || !tenant) {
    throw new AppError("Invitation could not be checked.", { status: 500, code: "INVITATION_LOOKUP_FAILED", retryable: true });
  }

  return { tenantName: tenant.tenant_name };
}

/**
 * Finds an invitation the owner withdrew for a signed-in user who has not completed setup, so the
 * invite link can explain what happened instead of offering the new-company form. Call this only
 * after findPendingInvitationForUser returned null: an open invitation always takes precedence.
 *
 * Only the user's most recent invitation counts, and only while its link would otherwise still be
 * valid (expires_at in the future). After that window the person is treated like any new sign-up,
 * so a withdrawn invitation never locks an email out of creating its own organization for good.
 */
export async function findWithdrawnInvitationForUser(userId: string): Promise<WithdrawnInvitationForUser | null> {
  const db = getSupabaseAdminClient();
  const { data: userData, error: userError } = await db.auth.admin.getUserById(userId);
  if (userError) {
    throw new AppError("Invitation could not be checked.", { status: 500, code: "INVITATION_LOOKUP_FAILED", retryable: true });
  }

  type LatestRow = { tenant_id: string; status: string; expires_at: string; created_at: string };
  const columns = "tenant_id,status,expires_at,created_at";
  const email = userData.user?.email?.trim().toLowerCase();

  const [byUser, byEmail] = await Promise.all([
    db.from("invitation_member").select(columns).eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    email
      ? db.from("invitation_member").select(columns).eq("email", email).order("created_at", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (byUser.error || byEmail.error) {
    throw new AppError("Invitation could not be checked.", { status: 500, code: "INVITATION_LOOKUP_FAILED", retryable: true });
  }

  const candidates = [byUser.data, byEmail.data].filter((row): row is LatestRow => row !== null);
  const row = candidates.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!row || row.status !== "revoked" || Date.parse(row.expires_at) <= Date.now()) {
    return null;
  }

  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("tenant_name")
    .eq("tenant_id", row.tenant_id)
    .maybeSingle();

  if (tenantError || !tenant) {
    throw new AppError("Invitation could not be checked.", { status: 500, code: "INVITATION_LOOKUP_FAILED", retryable: true });
  }

  return { tenantName: tenant.tenant_name };
}

const acceptInputSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  phoneNumber: z.string().trim().min(1).max(20),
  professionalRole: z.string().trim().min(1).max(120),
});

export interface AcceptInvitationResult {
  tenantId: string;
  role: string;
}

/**
 * The invitee's setup step. Only personal details are accepted; the tenant and role come from the
 * invitation row inside accept_member_invitation, which never creates a tenant.
 */
export async function acceptMemberInvitation(rawInput: unknown): Promise<AcceptInvitationResult> {
  const parsed = acceptInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError("Setup details are invalid.", { status: 400, code: "INVALID_ONBOARDING_INPUT" });
  }

  const details = requireValidAccountDetails(parsed.data);

  const supabase = await createAuthClient();
  const { data, error } = await supabase.rpc("accept_member_invitation", {
    p_full_name: details.fullName,
    p_phone_number: details.phoneNumber,
    p_professional_role: details.professionalRole,
  });

  if (error) {
    if (error.code === "P0002") {
      throw new AppError("This invitation is no longer valid. Ask your organization owner to invite you again.", {
        status: 404,
        code: "INVITATION_NOT_FOUND",
      });
    }
    throw new AppError("Setup could not be completed.", { status: 500, code: "ONBOARDING_FAILED" });
  }

  const row: { tenant_id: string; membership_role: string } | undefined = Array.isArray(data) ? data[0] : data;
  if (!row?.tenant_id) {
    throw new AppError("Setup could not be completed.", { status: 500, code: "ONBOARDING_FAILED" });
  }

  return { tenantId: row.tenant_id, role: row.membership_role };
}

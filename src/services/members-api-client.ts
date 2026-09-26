export type MemberRole = "owner" | "admin" | "employee";
export type InvitableRole = "admin" | "employee";

export interface TenantMember {
  userId: string;
  fullName: string;
  email: string;
  role: MemberRole;
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

export interface TenantSeatSummary {
  isPaid: boolean;
  paidSeats: number | null;
  usedSeats: number;
}

export interface TenantMembersOverview {
  currentUserId: string;
  canInvite: boolean;
  seats: TenantSeatSummary;
  members: TenantMember[];
  invitations: PendingInvitation[];
}

export type InvitationSendStatus =
  | "sent"
  | "saved_existing_account"
  | "already_member"
  | "already_invited"
  | "invalid_email"
  | "plan_required"
  | "seat_limit_reached"
  | "failed";

export interface InvitationSendResult {
  email: string;
  status: InvitationSendStatus;
  message: string;
}

type ApiErrorPayload = { error?: { message?: string } };

export async function getTenantMembers(signal?: AbortSignal): Promise<TenantMembersOverview> {
  const response = await fetch("/api/settings/members", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new Error((payload as ApiErrorPayload | null)?.error?.message ?? "Members could not be loaded.");
  }
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as TenantMembersOverview).members)) {
    throw new Error("The members response was invalid.");
  }
  return payload as TenantMembersOverview;
}

export async function sendInvitations(
  invitations: { email: string; role: InvitableRole }[],
): Promise<InvitationSendResult[]> {
  const response = await fetch("/api/settings/members/invitations", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ invitations }),
  });
  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new Error((payload as ApiErrorPayload | null)?.error?.message ?? "Invitations could not be sent.");
  }
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    throw new Error("The invitation response was invalid.");
  }
  return results as InvitationSendResult[];
}

export async function cancelInvitation(invitationId: string): Promise<void> {
  const response = await fetch(`/api/settings/members/invitations/${encodeURIComponent(invitationId)}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
    throw new Error(payload?.error?.message ?? "The invitation could not be removed.");
  }
}

export async function removeTenantMember(memberUserId: string): Promise<void> {
  const response = await fetch(`/api/settings/members/${encodeURIComponent(memberUserId)}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
    throw new Error(payload?.error?.message ?? "The member could not be removed.");
  }
}

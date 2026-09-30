"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ArrowDownWideNarrow,
  BriefcaseBusiness,
  Building2,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CreditCard,
  ExternalLink,
  LoaderCircle,
  Mail,
  Pencil,
  Phone,
  RotateCcw,
  Search,
  ReceiptText,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import { BillingPageClient } from "@/features/billing/billing-page-client";
import type { BillingOverview } from "@/lib/server/billing-service";
import { BillingOwnerOnlyError, getBillingOverview, getInvoices, type BillingInvoice } from "@/services/billing-api-client";
import {
  cancelInvitation,
  getTenantMembers,
  removeTenantMember,
  sendInvitations,
  type InvitableRole,
  type InvitationSendResult,
  type TenantMembersOverview,
  type TenantSeatSummary,
} from "@/services/members-api-client";
import { useRouter } from "next/navigation";
import { sanitizePhoneInput, validateAccountField } from "@/lib/account-details";
import {
  getProfileDetails,
  updateProfileDetails,
  type EditableProfileField,
  type ProfileDetails,
} from "@/services/profile-api-client";

// Mirrors the tenant_memberships.membership_role check constraint.
type MembershipRole = "owner" | "employee";

const ROLE_LABELS: Record<MembershipRole, string> = {
  owner: "Owner",
  employee: "Employee",
};

// Only one owner is allowed per tenant; invitations grant employee only (see InviteRowFields).
// The Members role filter offers only the roles a company actually uses: one owner and employees.
const FILTERABLE_ROLES: readonly MembershipRole[] = ["owner", "employee"];

type SettingsSection ="profile" | "members" | "billing" | "invoices";

const SECTION_LABELS: Record<SettingsSection, string> = {
  profile: "Profile",
  members: "Members",
  billing: "Billing",
  invoices: "Invoices",
};
type MembersTab = "team" | "pending";

type InviteRow = { id: number; email: string; role: MembershipRole };

// Outcomes after which the row is done: an email went out, or the invitation was recorded for
// an existing account that will be asked to join on its next sign-in.
const SENT_STATUSES: ReadonlySet<InvitationSendResult["status"]> = new Set(["sent", "saved_existing_account"]);

type MembersState =
  | { status: "loading" }
  | { status: "success"; overview: TenantMembersOverview }
  | { status: "error"; message: string };

export interface SettingsDialogProps {
  fullName: string;
  onClose: () => void;
  /** Section shown when the dialog opens; defaults to "profile". */
  initialSection?: SettingsSection;
}

export function SettingsDialog({ fullName, onClose, initialSection }: Readonly<SettingsDialogProps>) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection ?? "profile");

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function handleDialogKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusableElements?.length) {
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleDialogKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="mvp-settings-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="mvp-settings" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Settings">
        <aside className="mvp-settings__sidebar">
          <span className="mvp-settings__sidebar-title">Settings</span>
          <nav aria-label="Settings sections">
            {/* Your account: personal, the same in every company. Company: the active company only. */}
            <span className="mvp-settings__nav-group">Your account</span>
            <button
              type="button"
              className="mvp-settings__nav-item"
              aria-current={section === "profile" ? "page" : undefined}
              onClick={() => setSection("profile")}
            >
              <User size={17} aria-hidden="true" />
              <span>Profile</span>
            </button>

            <span className="mvp-settings__nav-group">Company</span>
            <button
              type="button"
              className="mvp-settings__nav-item"
              aria-current={section === "members" ? "page" : undefined}
              onClick={() => setSection("members")}
            >
              <Users size={17} aria-hidden="true" />
              <span>Members</span>
            </button>
            <button
              type="button"
              className="mvp-settings__nav-item"
              aria-current={section === "billing" ? "page" : undefined}
              onClick={() => setSection("billing")}
            >
              <CreditCard size={17} aria-hidden="true" />
              <span>Billing</span>
            </button>
            <button
              type="button"
              className="mvp-settings__nav-item"
              aria-current={section === "invoices" ? "page" : undefined}
              onClick={() => setSection("invoices")}
            >
              <ReceiptText size={17} aria-hidden="true" />
              <span>Invoices</span>
            </button>
          </nav>
        </aside>

        <div className="mvp-settings__main">
          <header className="mvp-settings__topbar">
            <nav className="mvp-settings__breadcrumb" aria-label="Breadcrumb">
              <strong aria-current="page">{SECTION_LABELS[section]}</strong>
            </nav>
            <button
              type="button"
              className="mvp-profile-dialog__close"
              ref={closeButtonRef}
              aria-label="Close settings"
              onClick={onClose}
            >
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className="mvp-settings__content">
            {section === "profile" ? <ProfileSection /> : null}
            {section === "members" ? <MembersSection fullName={fullName} onOpenBilling={() => setSection("billing")} /> : null}
            {section === "billing" ? <BillingSection /> : null}
            {section === "invoices" ? <InvoicesSection /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function MembersSection({ fullName, onOpenBilling }: Readonly<{ fullName: string; onOpenBilling: () => void }>) {
  const [membersState, setMembersState] = useState<MembersState>({ status: "loading" });
  const [requestVersion, setRequestVersion] = useState(0);
  const [activeTab, setActiveTab] = useState<MembersTab>("team");
  const tabsId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void getTenantMembers(controller.signal)
      .then((overview) => setMembersState({ status: "success", overview }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setMembersState({
            status: "error",
            message: error instanceof Error ? error.message : "Members could not be loaded.",
          });
        }
      });

    return () => controller.abort();
  }, [requestVersion]);

  const retry = useCallback(() => {
    setMembersState({ status: "loading" });
    setRequestVersion((version) => version + 1);
  }, []);

  // Reload quietly after sending, so new invitations show in the Pending tab.
  const refresh = useCallback(() => setRequestVersion((version) => version + 1), []);

  const canInvite = membersState.status === "success" && membersState.overview.canInvite;
  const seats = membersState.status === "success" ? membersState.overview.seats : null;
  const membershipRole =
    membersState.status === "success"
      ? membersState.overview.members.find((member) => member.userId === membersState.overview.currentUserId)?.role ?? null
      : null;
  const invitations = membersState.status === "success" ? membersState.overview.invitations : [];

  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const handleRemoveInvitation = useCallback(
    async (invitationId: string) => {
      setRemoveError(null);
      setRemovingId(invitationId);
      try {
        await cancelInvitation(invitationId);
        refresh();
      } catch (error) {
        setRemoveError(error instanceof Error ? error.message : "The invitation could not be removed.");
      } finally {
        setRemovingId(null);
      }
    },
    [refresh],
  );

  return (
    <section className="mvp-members" aria-labelledby={`${tabsId}-title`}>
      <header className="mvp-members__header">
        <h2 id={`${tabsId}-title`}>Members</h2>
        <p>Manage team members and invitations</p>
      </header>

      <InviteMembersCard
        canInvite={canInvite}
        seats={seats}
        isLoading={membersState.status === "loading"}
        membershipRole={membershipRole}
        onSent={refresh}
        onOpenBilling={onOpenBilling}
      />

      <div className="mvp-members__tabs" role="tablist" aria-label="Members views">
        <button
          type="button"
          role="tab"
          id={`${tabsId}-team-tab`}
          aria-selected={activeTab === "team"}
          aria-controls={`${tabsId}-team-panel`}
          className="mvp-members__tab"
          onClick={() => setActiveTab("team")}
        >
          Team Members
        </button>
        <button
          type="button"
          role="tab"
          id={`${tabsId}-pending-tab`}
          aria-selected={activeTab === "pending"}
          aria-controls={`${tabsId}-pending-panel`}
          className="mvp-members__tab"
          onClick={() => setActiveTab("pending")}
        >
          Pending Invitations
        </button>
      </div>

      {activeTab === "team" ? (
        <div role="tabpanel" id={`${tabsId}-team-panel`} aria-labelledby={`${tabsId}-team-tab`}>
          <TeamMembersPanel
            fullName={fullName}
            membershipRole={membershipRole}
            state={membersState}
            onMemberRemoved={refresh}
            onRetry={retry}
          />
        </div>
      ) : (
        <div role="tabpanel" id={`${tabsId}-pending-panel`} aria-labelledby={`${tabsId}-pending-tab`}>
          {invitations.length === 0 ? (
            <div className="mvp-members__empty">
              <Mail size={22} aria-hidden="true" />
              <strong>No pending invitations</strong>
              <span>Invitations you send will appear here until they are accepted.</span>
            </div>
          ) : (
            <>
              {removeError ? (
                <div className="mvp-members__state mvp-members__state--error" role="alert">
                  <CircleAlert size={20} aria-hidden="true" />
                  <span>{removeError}</span>
                </div>
              ) : null}
              <div className="mvp-members__list mvp-invites">
                <div className="mvp-invites__header">
                  <span>S.No</span>
                  <span>Email</span>
                  <span>Role</span>
                  <span>Status</span>
                  <span className="mvp-invites__action">{canInvite ? "Action" : null}</span>
                </div>
                {invitations.map((invitation, index) => (
                  <div className="mvp-invites__row" key={invitation.invitationId}>
                    <span className="mvp-members__index" aria-hidden="true">{index + 1}</span>
                    <div className="mvp-members__identity">
                      <strong>{invitation.email}</strong>
                      <span>Invited {formatDate(invitation.invitedAt)} · expires {formatDate(invitation.expiresAt)}</span>
                    </div>
                    <span className="mvp-members__role">{ROLE_LABELS[invitation.role]}</span>
                    <span>
                      <span className="mvp-members__pending-status">Pending</span>
                    </span>
                    <span className="mvp-invites__action">
                      {canInvite ? (
                        <button
                          type="button"
                          className="mvp-members__remove"
                          aria-label={`Remove invitation for ${invitation.email}`}
                          disabled={removingId === invitation.invitationId}
                          onClick={() => void handleRemoveInvitation(invitation.invitationId)}
                        >
                          {removingId === invitation.invitationId ? (
                            <LoaderCircle className="spin" size={15} aria-hidden="true" />
                          ) : (
                            <Trash2 size={15} aria-hidden="true" />
                          )}
                          Remove
                        </button>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function InviteMembersCard({
  canInvite,
  seats,
  isLoading,
  membershipRole,
  onSent,
  onOpenBilling,
}: Readonly<{
  canInvite: boolean;
  seats: TenantSeatSummary | null;
  isLoading: boolean;
  membershipRole: MembershipRole | null;
  onSent: () => void;
  onOpenBilling: () => void;
}>) {
  const nextRowId = useRef(1);
  const [rows, setRows] = useState<InviteRow[]>([{ id: 0, email: "", role: "employee" }]);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [results, setResults] = useState<InvitationSendResult[]>([]);
  const [confirmed, setConfirmed] = useState<InvitationSendResult[]>([]);
  const emailLabelId = useId();
  const roleLabelId = useId();

  function updateRow(id: number, patch: Partial<Omit<InviteRow, "id">>): void {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function takeRowId(): number {
    const id = nextRowId.current;
    nextRowId.current += 1;
    return id;
  }

  async function send(): Promise<void> {
    const filled = rows.filter((row) => row.email.trim().length > 0);
    if (filled.length === 0) {
      setSendError("Enter at least one email address.");
      return;
    }

    setIsSending(true);
    setSendError(null);
    setResults([]);
    try {
      const sent = await sendInvitations(
        filled.map((row) => ({ email: row.email.trim(), role: row.role as InvitableRole })),
      );
      // Successful sends are confirmed in a popup; anything else stays inline for attention.
      const succeeded = sent.filter((item) => SENT_STATUSES.has(item.status));
      setResults(sent.filter((item) => !SENT_STATUSES.has(item.status)));
      setConfirmed(succeeded);

      // Keep only the rows that still need attention; clear the ones that went through.
      const done = new Set(succeeded.map((item) => item.email.toLowerCase()));
      const remaining = filled.filter((row) => !done.has(row.email.trim().toLowerCase()));
      setRows(remaining.length > 0 ? remaining : [{ id: takeRowId(), email: "", role: "employee" }]);

      if (done.size > 0) {
        onSent();
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Invitations could not be sent.");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="mvp-invite-card">
      <div className="mvp-invite-card__body">
        <h3>Invite Members</h3>
        <p>Add new members to your team by entering their email address and assigning a role</p>

        <div className="mvp-invite-card__grid">
          <span className="mvp-invite-card__label" id={emailLabelId}>Email Address</span>
          <span className="mvp-invite-card__label" id={roleLabelId}>Role</span>

          {rows.map((row, index) => (
            <InviteRowFields
              key={row.id}
              row={row}
              index={index}
              emailLabelId={emailLabelId}
              roleLabelId={roleLabelId}
              onChange={(patch) => updateRow(row.id, patch)}
            />
          ))}
        </div>

        {results.length > 0 ? (
          <ul className="mvp-invite-card__results" aria-label="Invitation results">
            {results.map((item) => (
              <li key={item.email} className={`mvp-invite-card__result ${resultClassName(item.status)}`}>
                <strong>{item.email}</strong>
                <span>{item.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <footer className="mvp-invite-card__footer">
        {sendError ? (
          <span className="mvp-invite-card__footer-note mvp-invite-card__footer-note--error" role="alert">{sendError}</span>
        ) : null}
        {!sendError && !isLoading && membershipRole === "employee" ? (
          <span className="mvp-invite-card__footer-note">Only the Owner can invite members</span>
        ) : null}
        {!sendError && !isLoading && membershipRole === "owner" && seats ? (
          <span className="mvp-invite-card__footer-note">
            {seats.isPaid && seats.paidSeats !== null ? (
              `${seats.usedSeats} of ${seats.paidSeats} seats used`
            ) : (
              <>
                Inviting members needs a paid plan.{" "}
                <button type="button" className="mvp-invite-card__link" onClick={onOpenBilling}>
                  Go to Billing
                </button>
              </>
            )}
          </span>
        ) : null}
        <button
          type="button"
          className="mvp-invite-card__send"
          disabled={membershipRole === "employee" || !canInvite || isSending}
          onClick={() => void send()}
        >
          {isSending ? "Sending…" : "Send"}
        </button>
      </footer>

      {confirmed.length > 0 ? <InvitationSentPopup results={confirmed} onClose={() => setConfirmed([])} /> : null}
    </div>
  );
}

function EmailList({ emails }: Readonly<{ emails: string[] }>) {
  return emails.map((email, index) => (
    <span key={email}>
      {index > 0 ? ", " : null}
      <strong>{email}</strong>
    </span>
  ));
}

function InvitationSentPopup({ results, onClose }: Readonly<{ results: InvitationSendResult[]; onClose: () => void }>) {
  const okButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  // Supabase never emails an address that already has a confirmed account, so those invitations
  // are only saved. Say so plainly rather than claiming an email went out.
  const emailed = results.filter((item) => item.status === "sent").map((item) => item.email);
  const savedOnly = results.filter((item) => item.status === "saved_existing_account").map((item) => item.email);
  const title = emailed.length > 0 ? "Invitation sent successfully" : "Invitation saved";

  useEffect(() => {
    okButtonRef.current?.focus();
  }, []);

  return (
    <div
      className="mvp-invite-popup__backdrop"
      onKeyDown={(event) => {
        // Escape dismisses only the popup, not the whole Settings dialog behind it.
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="mvp-invite-popup" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <span className="mvp-invite-popup__icon" aria-hidden="true">
          <CircleCheck size={34} />
        </span>
        <h4 id={titleId}>{title}</h4>
        {emailed.length > 0 ? (
          <p>
            An invitation email has been sent to <EmailList emails={emailed} />. It will appear under Pending Invitations
            until accepted.
          </p>
        ) : null}
        {savedOnly.length > 0 ? (
          <p className="mvp-invite-popup__note">
            <EmailList emails={savedOnly} /> already {savedOnly.length > 1 ? "have accounts" : "has an account"}, so no
            email was sent. They will be asked to join your organization the next time they sign in.
          </p>
        ) : null}
        <button type="button" className="mvp-invite-popup__ok" ref={okButtonRef} onClick={onClose}>
          OK
        </button>
      </div>
    </div>
  );
}

function resultClassName(status: InvitationSendResult["status"]): string {
  if (SENT_STATUSES.has(status)) {
    return "mvp-invite-card__result--ok";
  }
  return status === "failed" || status === "invalid_email" || status === "plan_required" || status === "seat_limit_reached"
    ? "mvp-invite-card__result--error"
    : "";
}

function InviteRowFields({
  row,
  index,
  emailLabelId,
  roleLabelId,
  onChange,
}: Readonly<{
  row: InviteRow;
  index: number;
  emailLabelId: string;
  roleLabelId: string;
  onChange: (patch: Partial<Omit<InviteRow, "id">>) => void;
}>) {
  const suffix = index === 0 ? "" : ` ${index + 1}`;

  return (
    <>
      <input
        type="email"
        className="mvp-settings-input"
        placeholder="jane@example.com"
        aria-labelledby={index === 0 ? emailLabelId : undefined}
        aria-label={index === 0 ? undefined : `Email Address${suffix}`}
        value={row.email}
        onChange={(event) => onChange({ email: event.target.value })}
      />
      {/* Invitations grant Employee only, so the role is shown as fixed text rather than a one-option dropdown. */}
      <span
        className="mvp-settings-input mvp-invite-card__role"
        role="note"
        aria-labelledby={index === 0 ? roleLabelId : undefined}
        aria-label={index === 0 ? undefined : `Role${suffix}`}
      >
        {ROLE_LABELS[row.role]}
      </span>
    </>
  );
}

function TeamMembersPanel({
  fullName,
  membershipRole,
  state,
  onMemberRemoved,
  onRetry,
}: Readonly<{
  fullName: string;
  membershipRole: MembershipRole | null;
  state: MembersState;
  onMemberRemoved: () => void;
  onRetry: () => void;
}>) {
  const filterRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<MembershipRole | "all">("all");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [removeMemberError, setRemoveMemberError] = useState<string | null>(null);

  // "/" jumps to the filter box, matching the keyboard hint shown inside it.
  useEffect(() => {
    function handleSlash(event: KeyboardEvent) {
      const target = event.target;
      const isTyping =
        target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']");
      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        filterRef.current?.focus();
      }
    }

    document.addEventListener("keydown", handleSlash);
    return () => document.removeEventListener("keydown", handleSlash);
  }, []);

  const members =
    state.status === "success"
      ? state.overview.members.map((member) => ({
          key: member.userId,
          name: member.fullName || (member.userId === state.overview.currentUserId ? fullName : member.email),
          email: member.email,
          role: member.role,
          joinedAt: member.joinedAt,
        }))
      : [];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleMembers = members
    .filter(
      (member) =>
        (!normalizedQuery ||
          member.name.toLowerCase().includes(normalizedQuery) ||
          member.email.toLowerCase().includes(normalizedQuery)) &&
        (roleFilter === "all" || member.role === roleFilter),
    )
    .sort((a, b) => {
      const difference = new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
      return sortOrder === "newest" ? -difference : difference;
    });

  async function handleRemoveMember(memberUserId: string): Promise<void> {
    const confirmed = window.confirm(
      "Are you sure you want to remove this member? They will need to be invited again to rejoin.",
    );
    if (!confirmed) {
      return;
    }

    setRemoveMemberError(null);
    setRemovingMemberId(memberUserId);
    try {
      await removeTenantMember(memberUserId);
      onMemberRemoved();
    } catch (error) {
      setRemoveMemberError(error instanceof Error ? error.message : "The member could not be removed.");
    } finally {
      setRemovingMemberId(null);
    }
  }

  return (
    <>
      <div className="mvp-members__toolbar">
        <label className="mvp-members__search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={filterRef}
            type="search"
            placeholder="Filter"
            aria-label="Filter members"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd aria-hidden="true">/</kbd>
        </label>

        <div className="mvp-settings-select mvp-settings-select--strong">
          <select aria-label="Filter by role" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as MembershipRole | "all")}>
            <option value="all">All roles</option>
            {FILTERABLE_ROLES.map((role) => (
              <option key={role} value={role}>{ROLE_LABELS[role]}</option>
            ))}
          </select>
          <ChevronDown size={17} aria-hidden="true" />
        </div>

        <div className="mvp-settings-select mvp-settings-select--strong mvp-settings-select--with-icon">
          <ArrowDownWideNarrow className="mvp-settings-select__lead" size={17} aria-hidden="true" />
          <select aria-label="Sort by date" value={sortOrder} onChange={(event) => setSortOrder(event.target.value as "newest" | "oldest")}>
            <option value="newest">Date</option>
            <option value="oldest">Date (oldest)</option>
          </select>
          <ChevronDown size={17} aria-hidden="true" />
        </div>
      </div>

      {removeMemberError ? (
        <div className="mvp-members__state mvp-members__state--error" role="alert">
          <CircleAlert size={20} aria-hidden="true" />
          <span>{removeMemberError}</span>
        </div>
      ) : null}

      <div className="mvp-members__list mvp-members__table-wrap">
        <table className="mvp-members__table">
          <thead>
            <tr>
              <th scope="col">S.No</th>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Remove</th>
            </tr>
          </thead>
          <tbody>
            {visibleMembers.map((member, index) => (
              <tr key={member.key}>
                <td className="mvp-members__index">{index + 1}</td>
                <td>
                  <div className="mvp-members__name">
                    <span className="mvp-members__avatar" aria-hidden="true">{getInitials(member.name)}</span>
                    <strong>{member.name}</strong>
                  </div>
                </td>
                <td className="mvp-members__email">{member.email}</td>
                <td className="mvp-members__role">{ROLE_LABELS[member.role]}</td>
                <td className="mvp-members__remove-cell">
                  {membershipRole === "owner" && member.role === "employee" ? (
                    <button
                      type="button"
                      className="mvp-members__remove"
                      disabled={removingMemberId === member.key}
                      onClick={() => void handleRemoveMember(member.key)}
                    >
                      {removingMemberId === member.key ? "Removing…" : "Remove"}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {state.status === "loading" ? (
          <div className="mvp-members__state" role="status" aria-live="polite">
            <LoaderCircle className="spin" size={20} aria-hidden="true" />
            <span>Loading members…</span>
          </div>
        ) : null}

        {state.status === "error" ? (
          <div className="mvp-members__state mvp-members__state--error" role="alert">
            <CircleAlert size={20} aria-hidden="true" />
            <span>{state.message}</span>
            <button type="button" onClick={onRetry}>
              <RotateCcw size={15} aria-hidden="true" />
              Try again
            </button>
          </div>
        ) : null}

        {state.status === "success" && visibleMembers.length === 0 ? (
          <div className="mvp-members__state">
            <span>No members match these filters.</span>
          </div>
        ) : null}
      </div>
    </>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function getInitials(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

type ProfileState =
  | { status: "loading" }
  | { status: "success"; profile: ProfileDetails }
  | { status: "error"; message: string };

/** The signed-in person's details. Name and phone are editable inline; the rest is read-only. */
function ProfileSection() {
  const [state, setState] = useState<ProfileState>({ status: "loading" });
  const [requestVersion, setRequestVersion] = useState(0);
  const titleId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void getProfileDetails(controller.signal)
      .then((profile) => setState({ status: "success", profile }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ status: "error", message: error instanceof Error ? error.message : "Your profile could not be loaded." });
        }
      });
    return () => controller.abort();
  }, [requestVersion]);

  function retry(): void {
    setState({ status: "loading" });
    setRequestVersion((version) => version + 1);
  }

  return (
    <section className="mvp-members" aria-labelledby={titleId}>
      <header className="mvp-members__header">
        <h2 id={titleId}>Profile</h2>
        <p>Your personal and company information</p>
      </header>

      {state.status === "loading" ? (
        <div className="mvp-profile-loading" role="status" aria-live="polite">
          <LoaderCircle className="spin" size={26} aria-hidden="true" />
          <div>
            <strong>Loading your profile</strong>
            <span>Please wait a moment.</span>
          </div>
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="mvp-profile-error" role="alert">
          <span className="mvp-profile-error__icon"><CircleAlert size={24} aria-hidden="true" /></span>
          <div>
            <strong>Profile unavailable</strong>
            <p>{state.message}</p>
            <button type="button" onClick={retry}>
              <RotateCcw size={15} aria-hidden="true" />
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {state.status === "success" ? (
        <ProfileContent profile={state.profile} onSaved={(profile) => setState({ status: "success", profile })} />
      ) : null}
    </section>
  );
}

function ProfileContent({
  profile,
  onSaved,
}: Readonly<{ profile: ProfileDetails; onSaved: (profile: ProfileDetails) => void }>) {
  const router = useRouter();
  const [editing, setEditing] = useState<EditableProfileField | null>(null);

  async function save(field: EditableProfileField, value: string): Promise<void> {
    const updated = await updateProfileDetails({ [field]: value });
    onSaved(updated);
    setEditing(null);
    // Re-render the server-rendered shell so the sidebar name matches the saved profile.
    router.refresh();
  }

  const readOnlyFields = [
    { label: "Email", value: profile.emailAddress, icon: Mail },
    { label: "Company", value: profile.companyName, icon: Building2 },
    { label: "Professional Role", value: profile.professionalRole, icon: BriefcaseBusiness },
  ] as const;

  return (
    <div className="mvp-settings-profile">
      <div className="mvp-profile-summary">
        <span className="mvp-profile-summary__avatar" aria-hidden="true">{getInitials(profile.fullName)}</span>
        <div>
          <strong>{profile.fullName}</strong>
          <span>{profile.professionalRole}</span>
        </div>
      </div>

      <dl className="mvp-profile-fields">
        <EditableProfileRow
          field="fullName"
          label="Name"
          icon={User}
          value={profile.fullName}
          editValue={profile.fullName}
          isEditing={editing === "fullName"}
          onEdit={() => setEditing("fullName")}
          onCancel={() => setEditing(null)}
          onSave={(value) => save("fullName", value)}
        />
        <EditableProfileRow
          field="phoneNumber"
          label="Phone"
          icon={Phone}
          value={profile.phoneNumber}
          editValue={toLocalMobile(profile.phoneNumber)}
          isEditing={editing === "phoneNumber"}
          onEdit={() => setEditing("phoneNumber")}
          onCancel={() => setEditing(null)}
          onSave={(value) => save("phoneNumber", value)}
        />
        {readOnlyFields.map(({ label, value, icon: Icon }) => (
          <div className="mvp-profile-field" key={label}>
            <span className="mvp-profile-field__icon"><Icon size={18} aria-hidden="true" /></span>
            <div>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Stored phones are "91" + 10 digits; the edit box takes just the 10 digits, as at sign-up. */
function toLocalMobile(stored: string): string {
  return stored.length === 12 && stored.startsWith("91") ? stored.slice(2) : stored;
}

function EditableProfileRow({
  field,
  label,
  icon: Icon,
  value,
  editValue,
  isEditing,
  onEdit,
  onCancel,
  onSave,
}: Readonly<{
  field: EditableProfileField;
  label: string;
  icon: typeof User;
  value: string;
  editValue: string;
  isEditing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (value: string) => Promise<void>;
}>) {
  const inputId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState(editValue);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const isPhone = field === "phoneNumber";

  function startEditing(): void {
    setDraft(editValue);
    setError(null);
    onEdit();
  }

  async function submit(): Promise<void> {
    const message = validateAccountField(field, draft);
    if (message) {
      setError(message);
      return;
    }
    if (draft.trim() === editValue) {
      onCancel();
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Your profile could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className={`mvp-profile-field${isEditing ? " mvp-profile-field--editing" : ""}`}>
      <span className="mvp-profile-field__icon"><Icon size={18} aria-hidden="true" /></span>
      <div>
        <dt>{isEditing ? <label htmlFor={inputId}>{label}</label> : label}</dt>
        {isEditing ? (
          <dd>
            <form
              className="mvp-profile-edit"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <div className="mvp-profile-edit__control">
                {isPhone ? <span className="mvp-profile-edit__prefix" aria-hidden="true">+91</span> : null}
                <input
                  id={inputId}
                  autoFocus
                  value={draft}
                  inputMode={isPhone ? "numeric" : "text"}
                  autoComplete={isPhone ? "tel-national" : "name"}
                  maxLength={isPhone ? 10 : 60}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  disabled={isSaving}
                  onChange={(event) => {
                    setDraft(isPhone ? sanitizePhoneInput(event.target.value) : event.target.value);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    // Escape cancels this edit only; it must not also close the Settings dialog.
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      onCancel();
                    }
                  }}
                />
              </div>
              <button type="submit" className="mvp-profile-edit__save" aria-label={`Save ${label.toLowerCase()}`} disabled={isSaving}>
                {isSaving ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
              </button>
              <button type="button" className="mvp-profile-edit__cancel" aria-label="Cancel" disabled={isSaving} onClick={onCancel}>
                <X size={16} aria-hidden="true" />
              </button>
            </form>
            {error ? <p className="mvp-profile-edit__error" id={errorId} role="alert">{error}</p> : null}
          </dd>
        ) : (
          <dd className="mvp-profile-field__value">
            <span>{value}</span>
            <button type="button" className="mvp-profile-field__edit" aria-label={`Edit ${label.toLowerCase()}`} onClick={startEditing}>
              <Pencil size={14} aria-hidden="true" />
            </button>
          </dd>
        )}
      </div>
    </div>
  );
}

type BillingState =
  | { status: "loading" }
  | { status: "success"; overview: BillingOverview }
  | { status: "ownerOnly" }
  | { status: "error"; message: string };

/**
 * The active company's plan, seats, checkout and cancel — the same component as the /billing page, in
 * its embedded form. Owner only: an employee sees just the "only the owner" message, like Invoices.
 * (The /billing page stays: a company whose access has ended is sent there and cannot open Settings.)
 */
function BillingSection() {
  const [state, setState] = useState<BillingState>({ status: "loading" });
  const [requestVersion, setRequestVersion] = useState(0);
  const titleId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void getBillingOverview(controller.signal)
      .then((overview) => setState(overview.isOwner ? { status: "success", overview } : { status: "ownerOnly" }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ status: "error", message: error instanceof Error ? error.message : "Billing details could not be loaded." });
        }
      });
    return () => controller.abort();
  }, [requestVersion]);

  // Reload quietly after a payment or cancellation, keeping the current view on screen.
  const refresh = useCallback(() => setRequestVersion((version) => version + 1), []);

  return (
    <section className="mvp-members" aria-labelledby={titleId}>
      <header className="mvp-members__header">
        <h2 id={titleId}>Billing</h2>
        {state.status === "ownerOnly" ? null : <p>Your company&apos;s plan, seats and renewal</p>}
      </header>

      {state.status === "loading" ? (
        <div className="mvp-members__state" role="status">
          <LoaderCircle className="spin" size={20} aria-hidden="true" />
          <span>Loading billing…</span>
        </div>
      ) : null}

      {state.status === "ownerOnly" ? (
        <div className="mvp-members__state" role="status">
          <CircleAlert size={20} aria-hidden="true" />
          <span>Only the company owner can manage and view billing.</span>
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="mvp-members__state mvp-members__state--error" role="alert">
          <CircleAlert size={20} aria-hidden="true" />
          <span>{state.message}</span>
          <button
            type="button"
            onClick={() => {
              setState({ status: "loading" });
              setRequestVersion((version) => version + 1);
            }}
          >
            <RotateCcw size={14} aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : null}

      {state.status === "success" ? <BillingPageClient overview={state.overview} embedded onChanged={refresh} /> : null}
    </section>
  );
}

type InvoicesState =
  | { status: "loading" }
  | { status: "success"; invoices: BillingInvoice[] }
  | { status: "ownerOnly"; message: string }
  | { status: "error"; message: string };

function formatRupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paise / 100);
}

/**
 * Every invoice of the active company, newest first, in one scrollable list. One row = one captured
 * Razorpay payment; "View invoice" opens the Razorpay-hosted invoice for it. Owner only — an employee
 * sees just the "only the owner" message, with no Retry (a 403 can never succeed on retry).
 */
function InvoicesSection() {
  const [state, setState] = useState<InvoicesState>({ status: "loading" });
  const [requestVersion, setRequestVersion] = useState(0);
  const titleId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void getInvoices(controller.signal)
      .then((invoices) => setState({ status: "success", invoices }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        if (error instanceof BillingOwnerOnlyError) {
          setState({ status: "ownerOnly", message: error.message });
        } else {
          setState({ status: "error", message: error instanceof Error ? error.message : "Invoices could not be loaded." });
        }
      });
    return () => controller.abort();
  }, [requestVersion]);

  return (
    <section className="mvp-members" aria-labelledby={titleId}>
      <header className="mvp-members__header">
        <h2 id={titleId}>Invoices</h2>
        {state.status === "ownerOnly" ? null : <p>Every payment for this company, newest first</p>}
      </header>

      {state.status === "loading" ? (
        <div className="mvp-members__state" role="status">
          <LoaderCircle className="spin" size={20} aria-hidden="true" />
          <span>Loading invoices…</span>
        </div>
      ) : null}

      {state.status === "ownerOnly" ? (
        <div className="mvp-members__state" role="status">
          <CircleAlert size={20} aria-hidden="true" />
          <span>{state.message}</span>
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="mvp-members__state mvp-members__state--error" role="alert">
          <CircleAlert size={20} aria-hidden="true" />
          <span>{state.message}</span>
          <button
            type="button"
            onClick={() => {
              setState({ status: "loading" });
              setRequestVersion((version) => version + 1);
            }}
          >
            <RotateCcw size={14} aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : null}

      {state.status === "success" && state.invoices.length === 0 ? (
        <div className="mvp-members__empty">
          <ReceiptText size={22} aria-hidden="true" />
          <strong>No invoices yet</strong>
          <span>Invoices appear here after your first payment.</span>
        </div>
      ) : null}

      {state.status === "success" && state.invoices.length > 0 ? (
        <div className="mvp-members__list mvp-invoices">
          <div className="mvp-invoices__header">
            <span>S.No</span>
            <span>Paid on</span>
            <span>Period</span>
            <span>Amount</span>
            <span className="mvp-invoices__action">Invoice</span>
          </div>
          <div className="mvp-invoices__rows" tabIndex={0} aria-label={`${state.invoices.length} invoices, newest first`}>
            {state.invoices.map((invoice, index) => (
              <div className="mvp-invoices__row" key={invoice.paymentId}>
                <span className="mvp-members__index" aria-hidden="true">{index + 1}</span>
                <span>{formatDate(invoice.paidAt)}</span>
                <span className="mvp-invoices__period">
                  {formatDate(invoice.periodStart)} – {formatDate(invoice.periodEnd)}
                </span>
                <span className="mvp-invoices__amount">
                  <strong>{formatRupees(invoice.amountPaise)}</strong>
                  {invoice.paymentMethod ? <span>{invoice.paymentMethod.toUpperCase()}</span> : null}
                </span>
                <span className="mvp-invoices__action">
                  {invoice.invoiceUrl ? (
                    <a href={invoice.invoiceUrl} target="_blank" rel="noopener noreferrer">
                      View invoice
                      <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="mvp-invoices__missing">—</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

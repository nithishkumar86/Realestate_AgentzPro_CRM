"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ArrowDownWideNarrow,
  ChevronDown,
  CircleAlert,
  CirclePlus,
  CircleX,
  LoaderCircle,
  Mail,
  MoreHorizontal,
  RotateCcw,
  Search,
  Users,
  X,
} from "lucide-react";
import {
  getTenantMembers,
  sendInvitations,
  type InvitableRole,
  type InvitationSendResult,
  type TenantMembersOverview,
} from "@/services/members-api-client";

// Mirrors the tenant_memberships.membership_role check constraint.
type MembershipRole = "owner" | "admin" | "employee";

const ROLE_LABELS: Record<MembershipRole, string> = {
  owner: "Owner",
  admin: "Admin",
  employee: "Employee",
};

// Only one owner is allowed per tenant, so invitations can grant admin or employee.
const INVITABLE_ROLES: readonly MembershipRole[] = ["admin", "employee"];

type SettingsSection = "members";
type MembersTab = "team" | "pending";

type InviteRow = { id: number; email: string; role: MembershipRole };

// Matches MAX_INVITATIONS_PER_REQUEST on the server.
const MAX_INVITE_ROWS = 10;

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
}

export function SettingsDialog({ fullName, onClose }: Readonly<SettingsDialogProps>) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [section, setSection] = useState<SettingsSection>("members");

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
            <button
              type="button"
              className="mvp-settings__nav-item"
              aria-current={section === "members" ? "page" : undefined}
              onClick={() => setSection("members")}
            >
              <Users size={17} aria-hidden="true" />
              <span>Members</span>
            </button>
          </nav>
        </aside>

        <div className="mvp-settings__main">
          <header className="mvp-settings__topbar">
            <nav className="mvp-settings__breadcrumb" aria-label="Breadcrumb">
              <strong aria-current="page">Members</strong>
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
            {section === "members" ? <MembersSection fullName={fullName} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function MembersSection({ fullName }: Readonly<{ fullName: string }>) {
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
  const invitations = membersState.status === "success" ? membersState.overview.invitations : [];

  return (
    <section className="mvp-members" aria-labelledby={`${tabsId}-title`}>
      <header className="mvp-members__header">
        <h2 id={`${tabsId}-title`}>Members</h2>
        <p>Manage team members and invitations</p>
      </header>

      <InviteMembersCard canInvite={canInvite} isLoading={membersState.status === "loading"} onSent={refresh} />

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
          <TeamMembersPanel fullName={fullName} state={membersState} onRetry={retry} />
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
            <div className="mvp-members__list">
              {invitations.map((invitation) => (
                <div className="mvp-members__row" key={invitation.invitationId}>
                  <span className="mvp-members__avatar" aria-hidden="true">
                    <Mail size={17} />
                  </span>
                  <div className="mvp-members__identity">
                    <strong>{invitation.email}</strong>
                    <span>Invited {formatDate(invitation.invitedAt)} · expires {formatDate(invitation.expiresAt)}</span>
                  </div>
                  <span className="mvp-members__role">{ROLE_LABELS[invitation.role]}</span>
                  <span className="mvp-members__pending-status">Pending</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function InviteMembersCard({
  canInvite,
  isLoading,
  onSent,
}: Readonly<{ canInvite: boolean; isLoading: boolean; onSent: () => void }>) {
  const nextRowId = useRef(1);
  const [rows, setRows] = useState<InviteRow[]>([{ id: 0, email: "", role: "employee" }]);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [results, setResults] = useState<InvitationSendResult[]>([]);
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

  function addRow(): void {
    const id = takeRowId();
    setRows((current) => [...current, { id, email: "", role: "employee" }]);
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
      setResults(sent);

      // Keep only the rows that still need attention; clear the ones that went through.
      const done = new Set(
        sent.filter((item) => SENT_STATUSES.has(item.status)).map((item) => item.email.toLowerCase()),
      );
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

        <button type="button" className="mvp-invite-card__add" onClick={addRow} disabled={rows.length >= MAX_INVITE_ROWS}>
          <CirclePlus size={17} aria-hidden="true" />
          Add more
        </button>

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
        {!sendError && !isLoading && !canInvite ? (
          <span className="mvp-invite-card__footer-note">Only the owner can invite members.</span>
        ) : null}
        <button type="button" className="mvp-invite-card__send" disabled={!canInvite || isSending} onClick={() => void send()}>
          {isSending ? "Sending…" : "Send"}
        </button>
      </footer>
    </div>
  );
}

function resultClassName(status: InvitationSendResult["status"]): string {
  if (SENT_STATUSES.has(status)) {
    return "mvp-invite-card__result--ok";
  }
  return status === "failed" || status === "invalid_email" ? "mvp-invite-card__result--error" : "";
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
      <div className="mvp-settings-select">
        <select
          aria-labelledby={index === 0 ? roleLabelId : undefined}
          aria-label={index === 0 ? undefined : `Role${suffix}`}
          value={row.role}
          onChange={(event) => onChange({ role: event.target.value as MembershipRole })}
        >
          {INVITABLE_ROLES.map((role) => (
            <option key={role} value={role}>{ROLE_LABELS[role]}</option>
          ))}
        </select>
        <ChevronDown size={17} aria-hidden="true" />
      </div>
    </>
  );
}

function TeamMembersPanel({
  fullName,
  state,
  onRetry,
}: Readonly<{ fullName: string; state: MembersState; onRetry: () => void }>) {
  const filterRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<MembershipRole | "all">("all");
  const [twoFactorFilter, setTwoFactorFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");

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
          twoFactorEnabled: false,
        }))
      : [];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleMembers = members
    .filter(
      (member) =>
        (!normalizedQuery ||
          member.name.toLowerCase().includes(normalizedQuery) ||
          member.email.toLowerCase().includes(normalizedQuery)) &&
        (roleFilter === "all" || member.role === roleFilter) &&
        (twoFactorFilter === "all" || member.twoFactorEnabled === (twoFactorFilter === "enabled")),
    )
    .sort((a, b) => {
      const difference = new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
      return sortOrder === "newest" ? -difference : difference;
    });

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
            {(Object.keys(ROLE_LABELS) as MembershipRole[]).map((role) => (
              <option key={role} value={role}>{ROLE_LABELS[role]}</option>
            ))}
          </select>
          <ChevronDown size={17} aria-hidden="true" />
        </div>

        <div className="mvp-settings-select mvp-settings-select--strong">
          <select
            aria-label="Filter by 2FA status"
            value={twoFactorFilter}
            onChange={(event) => setTwoFactorFilter(event.target.value as "all" | "enabled" | "disabled")}
          >
            <option value="all">2FA Status</option>
            <option value="enabled">2FA Enabled</option>
            <option value="disabled">2FA Disabled</option>
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

      <div className="mvp-members__list">
        <div className="mvp-members__list-header">
          <label className="mvp-members__select-all">
            <input type="checkbox" disabled />
            <span>Select all ({visibleMembers.length})</span>
          </label>
          <button type="button" className="mvp-members__more" aria-label="Bulk actions">
            <MoreHorizontal size={18} aria-hidden="true" />
          </button>
        </div>

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

        {visibleMembers.map((member) => (
          <div className="mvp-members__row" key={member.key}>
            <span className="mvp-members__avatar" aria-hidden="true">{getInitials(member.name)}</span>
            <div className="mvp-members__identity">
              <strong>{member.name}</strong>
              <span>{member.email}</span>
            </div>
            <span className="mvp-members__role">{ROLE_LABELS[member.role]}</span>
            <span className="mvp-members__2fa">
              <CircleX size={16} aria-hidden="true" />
              2FA
            </span>
            <button type="button" className="mvp-members__more" aria-label={`Actions for ${member.name}`}>
              <MoreHorizontal size={18} aria-hidden="true" />
            </button>
          </div>
        ))}
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

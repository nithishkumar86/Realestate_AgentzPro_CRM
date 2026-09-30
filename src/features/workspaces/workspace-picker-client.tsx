"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { AccountField, useAccountDetailsForm } from "@/features/auth/account-details-form";
import { COMPANY_NAME_MAX } from "@/lib/account-details";
import type { UserWorkspaces } from "@/lib/server/workspace-service";
import styles from "./workspace-picker.module.css";

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  employee: "Employee",
};

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

const CREATE_FIELDS = ["companyName"] as const;

interface ResponseBody {
  redirectTo?: string;
  error?: { message?: string; details?: { fieldErrors?: unknown } };
}

/** Stored phones are "91" + 10 digits; shown as "+91 9876543210", as on the sign-up form. */
function formatPhone(stored: string): string {
  return stored.length === 12 && stored.startsWith("91") ? `+91 ${stored.slice(2)}` : stored;
}

/** Same approach as owner onboarding: the browser's zone, never trusted by the server. */
function detectTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export interface WorkspacePickerClientProps {
  workspaces: UserWorkspaces;
  activeTenantId: string | null;
  /** The signed-in person's saved details, reused for a new company; null hides the "Creating as" line. */
  creator?: { fullName: string; phoneNumber: string; professionalRole: string } | null;
  /** True only when a company is already open, so X / Cancel have a dashboard to go back to. */
  canDismiss?: boolean;
}

const DASHBOARD_PATH = "/dashboard";

/** Up to two initials for the company avatar, e.g. "Ravi Realty" -> "RR". */
function initials(name: string): string {
  const letters = name.trim().split(/\s+/).slice(0, 2).map((word) => word.charAt(0).toUpperCase());
  return letters.join("") || "?";
}

/**
 * The company switcher. Every action posts to a server route that re-checks the signed-in user's
 * own membership or invitation; nothing here decides access by itself.
 */
export function WorkspacePickerClient({
  workspaces,
  activeTenantId,
  creator = null,
  canDismiss = false,
}: Readonly<WorkspacePickerClientProps>) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const form = useAccountDetailsForm(CREATE_FIELDS);

  const { companies, invitations, ownsCompany } = workspaces;
  // One company at a time: the radio group holds a single tenant id, so two can never be open together.
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(
    companies.some((company) => company.tenantId === activeTenantId && company.membershipStatus === "active")
      ? activeTenantId
      : null,
  );
  // Stays true after a successful Apply so the button keeps saying "Opening…" until the page changes,
  // instead of flashing back to "Apply" while the next screen loads.
  const [isOpening, setIsOpening] = useState(false);
  const isBusy = pendingAction !== null || isOpening;

  async function post(actionKey: string, url: string, body?: unknown): Promise<ResponseBody | null> {
    setPendingAction(actionKey);
    setErrorMessage(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as ResponseBody | null;
      if (!response.ok) {
        if (form.applyServerErrors(payload?.error?.details?.fieldErrors)) {
          return null;
        }
        throw new Error(payload?.error?.message ?? GENERIC_ERROR_MESSAGE);
      }
      return payload ?? {};
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : GENERIC_ERROR_MESSAGE);
      return null;
    } finally {
      setPendingAction(null);
    }
  }

  function enter(result: ResponseBody | null): void {
    if (result) {
      router.replace(result.redirectTo ?? "/");
      router.refresh();
    }
  }

  async function openCompany(tenantId: string): Promise<void> {
    // Applying a company always lands on its dashboard (Accept / Create still follow the server's redirect).
    if (await post(`open:${tenantId}`, "/api/workspaces/active", { tenantId })) {
      setIsOpening(true);
      router.replace(DASHBOARD_PATH);
      router.refresh();
    }
  }

  function dismiss(): void {
    router.push(DASHBOARD_PATH);
  }

  async function acceptInvitation(invitationId: string): Promise<void> {
    enter(await post(`accept:${invitationId}`, `/api/workspaces/invitations/${invitationId}/accept`));
  }

  async function declineInvitation(invitationId: string): Promise<void> {
    if (await post(`decline:${invitationId}`, `/api/workspaces/invitations/${invitationId}/decline`)) {
      router.refresh();
    }
  }

  async function createCompany(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!form.validateAll()) {
      return;
    }
    enter(await post("create", "/api/workspaces", { companyName: form.values.companyName, timezone: detectTimezone() }));
  }

  return (
    <div className={`auth-card ${styles.card}`}>
      <div className={styles.header}>
        <div>
          <h1 className="auth-card__title">Your companies</h1>
          <p className="auth-card__subtitle">
            Choose the company you want to work in. You can switch any time from the account menu.
          </p>
        </div>
        {canDismiss ? (
          <button type="button" className={styles.close} aria-label="Close" disabled={isBusy} onClick={dismiss}>
            <X size={18} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {invitations.length > 0 ? (
        <section className={styles.section} aria-labelledby="workspace-invitations-title">
          <h2 id="workspace-invitations-title" className={styles.sectionTitle}>Invitations</h2>
          <ul className={styles.list}>
            {invitations.map((invitation) => (
              <li key={invitation.invitationId} className={styles.row}>
                <span className={styles.identity}>
                  <span className={styles.name}>{invitation.tenantName}</span>
                  <span className={styles.meta}>Invited you as {ROLE_LABELS[invitation.role] ?? invitation.role}</span>
                </span>
                <span className={styles.actions}>
                  <button
                    type="button"
                    className="button"
                    disabled={isBusy}
                    onClick={() => void acceptInvitation(invitation.invitationId)}
                  >
                    {pendingAction === `accept:${invitation.invitationId}` ? "Joining…" : "Accept"}
                  </button>
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={isBusy}
                    onClick={() => void declineInvitation(invitation.invitationId)}
                  >
                    {pendingAction === `decline:${invitation.invitationId}` ? "Declining…" : "Decline"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby="workspace-companies-title">
        <h2 id="workspace-companies-title" className={styles.sectionTitle}>Companies</h2>
        {companies.length > 0 ? (
          <>
            <fieldset className={styles.group} disabled={isBusy}>
              <legend className="sr-only">Company to work in</legend>
              {companies.map((company) => {
                const isActive = company.tenantId === activeTenantId;
                const isPaused = company.membershipStatus !== "active";
                const isSelected = company.tenantId === selectedTenantId;
                return (
                  <label
                    key={company.tenantId}
                    className={`${styles.option} ${isSelected ? styles.optionSelected : ""} ${isPaused ? styles.optionPaused : ""}`}
                  >
                    <input
                      type="radio"
                      name="company"
                      className={styles.radio}
                      value={company.tenantId}
                      checked={isSelected}
                      disabled={isPaused}
                      onChange={() => setSelectedTenantId(company.tenantId)}
                    />
                    <span className={styles.avatar} aria-hidden="true">{initials(company.tenantName)}</span>
                    <span className={styles.identity}>
                      <span className={styles.name}>{company.tenantName}</span>
                      <span className={styles.meta}>
                        {pendingAction === `open:${company.tenantId}`
                          ? "Opening…"
                          : isPaused
                            ? "Access paused"
                            : ROLE_LABELS[company.role] ?? company.role}
                      </span>
                    </span>
                    {isActive ? <span className={styles.badge}>Current</span> : null}
                  </label>
                );
              })}
            </fieldset>
            <div className={styles.footer}>
              {canDismiss ? (
                <button type="button" className="button button--secondary" disabled={isBusy} onClick={dismiss}>
                  Cancel
                </button>
              ) : null}
              <button
                type="button"
                className="button"
                disabled={isBusy || selectedTenantId === null}
                onClick={() => selectedTenantId && void openCompany(selectedTenantId)}
              >
                {isOpening || pendingAction?.startsWith("open:") ? "Opening…" : "Apply"}
              </button>
            </div>
          </>
        ) : (
          <p className={styles.empty}>You are not part of any company yet. Accept an invitation or create your own company.</p>
        )}
      </section>

      {!ownsCompany ? (
        <section className={styles.section} aria-labelledby="workspace-create-title">
          <h2 id="workspace-create-title" className={styles.sectionTitle}>Your own company</h2>
          {isCreateOpen ? (
            <form className="auth-form" noValidate onSubmit={(event) => void createCompany(event)}>
              {creator ? (
                <div className={styles.creator}>
                  <p>
                    Creating as <strong>{creator.fullName}</strong> · {formatPhone(creator.phoneNumber)} · {creator.professionalRole}
                  </p>
                  <p>
                    You will be the <strong>Owner</strong> of this new company. To change your name, phone or professional
                    role, go to Settings → Profile.
                  </p>
                </div>
              ) : null}
              <AccountField
                name="companyName"
                label="Company name"
                type="text"
                autoComplete="organization"
                autoFocus
                maxLength={COMPANY_NAME_MAX}
                value={form.values.companyName}
                error={form.errors.companyName}
                onValueChange={form.change}
                onFieldBlur={form.blur}
              />
              <button className="button" type="submit" disabled={isBusy}>
                {pendingAction === "create" ? "Creating company…" : "Create company"}
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="button button--secondary"
              disabled={isBusy}
              onClick={() => setIsCreateOpen(true)}
            >
              + Create new company
            </button>
          )}
        </section>
      ) : null}

      {errorMessage ? (
        <p className="auth-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}

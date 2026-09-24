"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AccountField, useAccountDetailsForm } from "@/features/auth/account-details-form";
import { COMPANY_NAME_MAX } from "@/lib/account-details";
import type { UserWorkspaces } from "@/lib/server/workspace-service";
import styles from "./workspace-picker.module.css";

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  employee: "Employee",
};

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

const CREATE_FIELDS = ["companyName"] as const;

interface ResponseBody {
  redirectTo?: string;
  error?: { message?: string; details?: { fieldErrors?: unknown } };
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
}

/**
 * The company switcher. Every action posts to a server route that re-checks the signed-in user's
 * own membership or invitation; nothing here decides access by itself.
 */
export function WorkspacePickerClient({ workspaces, activeTenantId }: Readonly<WorkspacePickerClientProps>) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const form = useAccountDetailsForm(CREATE_FIELDS);

  const { companies, invitations, ownsCompany } = workspaces;
  const isBusy = pendingAction !== null;

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
    enter(await post(`open:${tenantId}`, "/api/workspaces/active", { tenantId }));
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
      <h1 className="auth-card__title">Your companies</h1>
      <p className="auth-card__subtitle">
        Choose the company you want to work in. You can switch any time from the account menu.
      </p>

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
          <ul className={styles.list}>
            {companies.map((company) => {
              const isActive = company.tenantId === activeTenantId;
              const isPaused = company.membershipStatus !== "active";
              return (
                <li key={company.tenantId}>
                  <button
                    type="button"
                    className={`${styles.row} ${styles.rowButton}`}
                    disabled={isBusy || isPaused}
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => void openCompany(company.tenantId)}
                  >
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
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={styles.empty}>You are not part of any company yet. Accept an invitation or create your own company.</p>
        )}
      </section>

      {!ownsCompany ? (
        <section className={styles.section} aria-labelledby="workspace-create-title">
          <h2 id="workspace-create-title" className={styles.sectionTitle}>Your own company</h2>
          {isCreateOpen ? (
            <form className="auth-form" noValidate onSubmit={(event) => void createCompany(event)}>
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

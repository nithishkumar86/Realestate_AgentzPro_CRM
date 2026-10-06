"use client";

import { ChevronDown, CircleAlert, LoaderCircle, Megaphone, RotateCcw, Users } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AdAssignmentOwnerOnlyError,
  applyAdAssignee,
  getAdAssignments,
  setAdAssignee,
  type AdAssignment,
  type AdAssignmentMember,
} from "@/services/ad-assignments-api-client";

type SectionState =
  | { status: "loading" }
  | { status: "success"; ads: AdAssignment[]; members: AdAssignmentMember[]; isOwner: boolean }
  | { status: "ownerOnly"; message: string }
  | { status: "error"; message: string };

type RowNotice = { tone: "success" | "error"; text: string; retry?: () => void };

/** The owner picked a person for an ad; the dialog asks which leads that person should receive. */
type PendingChoice = { ad: AdAssignment; userId: string; name: string; ruleExists: boolean };

function adLabel(ad: AdAssignment): string {
  return ad.adName ?? "Name pending";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Owner only: pick ONE team member per ad. New leads from that ad are then assigned automatically (by the
 * database, to an active member only). Leads that arrived before the rule can be assigned with one click; leads
 * that already have an assignee are never touched. An employee sees just the "only the owner" message.
 */
export function AdAssignmentSection() {
  const [state, setState] = useState<SectionState>({ status: "loading" });
  const [requestVersion, setRequestVersion] = useState(0);
  const [busyAdId, setBusyAdId] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, RowNotice>>({});
  const [pending, setPending] = useState<PendingChoice | null>(null);
  const titleId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void getAdAssignments(controller.signal)
      .then((overview) => setState({ status: "success", ads: overview.ads, members: overview.members, isOwner: overview.isOwner }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof AdAssignmentOwnerOnlyError) setState({ status: "ownerOnly", message: error.message });
        else setState({ status: "error", message: error instanceof Error ? error.message : "Ad assignments could not be loaded." });
      });
    return () => controller.abort();
  }, [requestVersion]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setRequestVersion((version) => version + 1);
  }, []);

  const setNotice = (adId: string, notice: RowNotice | null) => setNotices((current) => {
    const next = { ...current };
    if (notice) next[adId] = notice; else delete next[adId];
    return next;
  });

  /**
   * Saves the rule (new leads of this ad go to `userId`, or nobody) and, when asked, also gives the ad's leads that are
   * still unassigned to that person. Leads that already have an assignee are never touched.
   */
  async function saveAndAssign(ad: AdAssignment, userId: string | null, name: string, save: boolean, includeEarlier: boolean, ruleJustSet = save): Promise<void> {
    setBusyAdId(ad.adId);
    setNotice(ad.adId, null);
    try {
      if (save) {
        try {
          await setAdAssignee(ad.adId, userId);
        } catch (error) {
          setNotice(ad.adId, { tone: "error", text: error instanceof Error ? error.message : "The ad assignment could not be saved." });
          return;
        }
        setState((current) => current.status === "success"
          ? { ...current, ads: current.ads.map((item) => item.adId === ad.adId ? { ...item, assigneeUserId: userId } : item) }
          : current);
      }
      if (!userId) {
        setNotice(ad.adId, { tone: "success", text: "New leads from this ad are left unassigned. Leads that already have an assignee are unchanged." });
        return;
      }
      if (!includeEarlier) {
        const left = ad.unassignedLeads > 0 ? ` The ${plural(ad.unassignedLeads, "earlier lead")} stay${ad.unassignedLeads === 1 ? "s" : ""} unassigned.` : "";
        setNotice(ad.adId, { tone: "success", text: `${name} will get all upcoming leads from this ad.${left}` });
        return;
      }
      try {
        const assigned = await applyAdAssignee(ad.adId);
        setState((current) => current.status === "success"
          ? { ...current, ads: current.ads.map((item) => item.adId === ad.adId ? { ...item, unassignedLeads: Math.max(0, item.unassignedLeads - assigned) } : item) }
          : current);
        const earlier = plural(assigned, "earlier unassigned lead");
        const text = ruleJustSet
          ? assigned > 0
            ? `Done. ${earlier} and all upcoming leads from this ad are now assigned to ${name}.`
            : `Done. All upcoming leads from this ad will be assigned to ${name}.`
          : assigned > 0 ? `Done. ${earlier} now assigned to ${name}.` : "No unassigned leads were left to assign.";
        setNotice(ad.adId, { tone: "success", text });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "The unassigned leads could not be assigned.";
        setNotice(ad.adId, {
          tone: "error",
          text: save ? `Saved for new leads, but the unassigned leads were not assigned. ${reason}` : reason,
          retry: () => void saveAndAssign(ad, userId, name, false, true, ruleJustSet),
        });
      }
    } finally {
      setBusyAdId(null);
    }
  }

  /** The dropdown only asks; nothing is saved until the owner answers (the select is controlled, so Cancel keeps the old value). */
  function changeAssignee(ad: AdAssignment, members: AdAssignmentMember[], value: string): void {
    if (state.status !== "success" || !state.isOwner) return;
    if (value === (ad.assigneeUserId ?? "")) return;
    if (!value) {
      void saveAndAssign(ad, null, "", true, false);
      return;
    }
    const name = members.find((member) => member.userId === value)?.fullName ?? "this member";
    if (ad.unassignedLeads === 0) {
      void saveAndAssign(ad, value, name, true, false);
      return;
    }
    setPending({ ad, userId: value, name, ruleExists: false });
  }

  function answer(includeEarlier: boolean): void {
    if (!pending || state.status !== "success" || !state.isOwner) return;
    const { ad, userId, name, ruleExists } = pending;
    setPending(null);
    void saveAndAssign(ad, userId, name, !ruleExists, includeEarlier);
  }

  return (
    <section className="mvp-members" aria-labelledby={titleId}>
      <header className="mvp-members__header">
        <h2 id={titleId}>Lead assignment</h2>
        {state.status === "ownerOnly" ? null : <p>{state.status === "success" && !state.isOwner ? "Who receives the leads of each ad" : "Choose who receives the leads of each ad"}</p>}
      </header>

      {state.status === "loading" ? (
        <div className="mvp-members__state" role="status">
          <LoaderCircle className="spin" size={20} aria-hidden="true" />
          <span>Loading ads…</span>
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
          <button type="button" onClick={retry}>
            <RotateCcw size={14} aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : null}

      {state.status === "success" ? (
        <>
          <p className="mvp-adrules__intro">
            {state.isOwner
              ? "Choose one person per ad. They get every new lead from that ad, and any lead of that ad that is still unassigned. Leads that already have an assignee are not changed. Blocked members are skipped, and their leads stay unassigned."
              : "Only the company owner can change who receives each ad's leads. You can see the current assignments here."}
          </p>
          {state.ads.length === 0 ? (
            <div className="mvp-members__empty">
              <Megaphone size={22} aria-hidden="true" />
              <strong>No ads yet</strong>
              <span>An ad appears here after it receives its first lead.</span>
            </div>
          ) : (
            <div className="mvp-members__list mvp-members__table-wrap">
              <table className="mvp-adrules__table">
                <thead>
                  <tr>
                    <th scope="col">S.No</th>
                    <th scope="col">Ad name</th>
                    <th scope="col">Assign new leads to</th>
                    <th scope="col">Assign already arrived leads</th>
                  </tr>
                </thead>
                <tbody>
                  {state.ads.map((ad, index) => {
                    const busy = busyAdId === ad.adId;
                    const notice = notices[ad.adId];
                    const current = ad.assigneeUserId ?? "";
                    const currentIsActive = !current || state.members.some((member) => member.userId === current);
                    const assignee = state.members.find((member) => member.userId === current);
                    return (
                      <tr key={ad.adId}>
                        <td className="mvp-adrules__count">{index + 1}</td>
                        <td>
                          <div className="mvp-adrules__ad">
                            <strong title={adLabel(ad)}>{adLabel(ad)}</strong>
                          </div>
                        </td>
                        <td>
                          <div className="mvp-settings-select">
                            <select
                              aria-label={`Who receives the new leads of ${adLabel(ad)}`}
                              value={current}
                              disabled={busy || !state.isOwner}
                              onChange={(event) => changeAssignee(ad, state.members, event.target.value)}
                            >
                              <option value="">Unassigned</option>
                              {currentIsActive ? null : <option value={current} disabled>Blocked member</option>}
                              {state.members.map((member) => (
                                <option key={member.userId} value={member.userId}>{member.fullName}</option>
                              ))}
                            </select>
                            <ChevronDown size={17} aria-hidden="true" />
                          </div>
                        </td>
                        <td>
                          <div className="mvp-adrules__apply">
                            {ad.unassignedLeads === 0 ? (
                              <span className="mvp-adrules__pill mvp-adrules__pill--ok">None</span>
                            ) : !state.isOwner ? (
                              <span className="mvp-adrules__pill mvp-adrules__pill--warn">{plural(ad.unassignedLeads, "lead")} unassigned</span>
                            ) : assignee ? (
                              <div className="mvp-settings-select">
                                <select
                                  aria-label={`Assign the already arrived leads of ${adLabel(ad)}`}
                                  value=""
                                  disabled={busy}
                                  onChange={(event) => {
                                    if (event.target.value) setPending({ ad, userId: assignee.userId, name: assignee.fullName, ruleExists: true });
                                  }}
                                >
                                  <option value="">{plural(ad.unassignedLeads, "lead")} unassigned – choose…</option>
                                  <option value={assignee.userId}>Assign {ad.unassignedLeads === 1 ? "it" : `all ${ad.unassignedLeads}`} to {assignee.fullName}</option>
                                </select>
                                <ChevronDown size={17} aria-hidden="true" />
                              </div>
                            ) : (
                              <span className="mvp-adrules__pill mvp-adrules__pill--warn">
                                Still {plural(ad.unassignedLeads, "lead")} unassigned. Choose a person to assign.
                              </span>
                            )}
                            {busy ? <span className="mvp-adrules__muted">Saving…</span> : null}
                            {notice ? (
                              <span className={`mvp-adrules__notice mvp-adrules__notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
                                {notice.text}
                                {notice.retry ? (
                                  <button type="button" className="mvp-adrules__link" disabled={busy} onClick={notice.retry}>Retry</button>
                                ) : null}
                              </span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      {pending ? <AssignChoiceDialog choice={pending} onAnswer={answer} onCancel={() => setPending(null)} /> : null}
    </section>
  );
}

/** Asks the owner which leads of the ad the chosen person should receive. Reuses the invite popup's look. */
function AssignChoiceDialog({ choice, onAnswer, onCancel }: { choice: PendingChoice; onAnswer: (includeEarlier: boolean) => void; onCancel: () => void }) {
  const titleId = useId();
  const firstRef = useRef<HTMLButtonElement>(null);
  const { ad, name, ruleExists } = choice;
  const count = ad.unassignedLeads;
  const earlier = plural(count, "earlier lead");

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  return (
    <div
      className="mvp-invite-popup__backdrop"
      onKeyDown={(event) => {
        // Escape dismisses only this question, not the Settings dialog behind it.
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="mvp-invite-popup" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <span className="mvp-invite-popup__icon" aria-hidden="true"><Users size={22} /></span>
        <h4 id={titleId}>{ruleExists ? `Assign the unassigned leads to ${name}?` : `Assign this ad's leads to ${name}?`}</h4>
        <p>
          {ruleExists
            ? `${earlier} of ${adLabel(ad)} ${count === 1 ? "is" : "are"} still unassigned. Assign ${count === 1 ? "it" : "them"} to ${name}?`
            : `${earlier} of ${adLabel(ad)} ${count === 1 ? "is" : "are"} still unassigned. If you click OK, ${count === 1 ? "that lead" : `those ${count} leads`} and every upcoming lead from this ad will be assigned to ${name}.`}
        </p>
        <div className="mvp-adrules-dialog__options">
          <button type="button" ref={firstRef} className="mvp-adrules-dialog__option mvp-adrules-dialog__option--primary" onClick={() => onAnswer(true)}>
            <strong>{ruleExists ? "OK, assign" : `OK, assign to ${name}`}</strong>
          </button>
          {ruleExists ? null : (
            <button type="button" className="mvp-adrules-dialog__option" onClick={() => onAnswer(false)}>
              <strong>Only upcoming leads</strong>
              <span>The {earlier} stay{count === 1 ? "s" : ""} unassigned.</span>
            </button>
          )}
        </div>
        <p className="mvp-adrules-dialog__note">Leads that already have an assignee are not changed.</p>
        <button type="button" className="mvp-adrules-dialog__cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

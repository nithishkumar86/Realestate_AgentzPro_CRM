"use client";

import { ChevronDown, CircleAlert, LoaderCircle, Megaphone, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
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
  | { status: "success"; ads: AdAssignment[]; members: AdAssignmentMember[] }
  | { status: "ownerOnly"; message: string }
  | { status: "error"; message: string };

type RowNotice = { tone: "success" | "error"; text: string };

function adLabel(ad: AdAssignment): string {
  return ad.adName ?? "Name pending";
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
  const titleId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void getAdAssignments(controller.signal)
      .then((overview) => setState({ status: "success", ads: overview.ads, members: overview.members }))
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

  async function changeAssignee(ad: AdAssignment, members: AdAssignmentMember[], value: string): Promise<void> {
    const assigneeUserId = value || null;
    if (assigneeUserId === ad.assigneeUserId) return;
    setBusyAdId(ad.adId);
    setNotice(ad.adId, null);
    try {
      await setAdAssignee(ad.adId, assigneeUserId);
      setState((current) => current.status === "success"
        ? { ...current, ads: current.ads.map((item) => item.adId === ad.adId ? { ...item, assigneeUserId } : item) }
        : current);
      const name = members.find((member) => member.userId === assigneeUserId)?.fullName;
      setNotice(ad.adId, { tone: "success", text: name ? `New leads from this ad go to ${name}.` : "New leads from this ad are left unassigned." });
    } catch (error) {
      setNotice(ad.adId, { tone: "error", text: error instanceof Error ? error.message : "The ad assignment could not be saved." });
    } finally {
      setBusyAdId(null);
    }
  }

  async function assignExisting(ad: AdAssignment, members: AdAssignmentMember[]): Promise<void> {
    const name = members.find((member) => member.userId === ad.assigneeUserId)?.fullName ?? "the selected member";
    const count = ad.unassignedLeads;
    if (!window.confirm(`Assign the ${count} unassigned lead${count === 1 ? "" : "s"} of this ad to ${name}? Leads that already have an assignee are not changed.`)) return;
    setBusyAdId(ad.adId);
    setNotice(ad.adId, null);
    try {
      const assigned = await applyAdAssignee(ad.adId);
      setState((current) => current.status === "success"
        ? { ...current, ads: current.ads.map((item) => item.adId === ad.adId ? { ...item, unassignedLeads: Math.max(0, item.unassignedLeads - assigned) } : item) }
        : current);
      setNotice(ad.adId, { tone: "success", text: `${assigned} lead${assigned === 1 ? "" : "s"} assigned to ${name}.` });
    } catch (error) {
      setNotice(ad.adId, { tone: "error", text: error instanceof Error ? error.message : "The unassigned leads could not be assigned." });
    } finally {
      setBusyAdId(null);
    }
  }

  return (
    <section className="mvp-members" aria-labelledby={titleId}>
      <header className="mvp-members__header">
        <h2 id={titleId}>Lead assignment</h2>
        {state.status === "ownerOnly" ? null : <p>Choose who receives the leads of each ad</p>}
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
            New leads from an ad are assigned automatically to the person you choose. Leads that arrived earlier stay unassigned
            until you assign them. Blocked members are skipped, and their new leads stay unassigned.
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
                    <th scope="col">Ad</th>
                    <th scope="col">Leads</th>
                    <th scope="col">New leads go to</th>
                    <th scope="col">Earlier leads</th>
                  </tr>
                </thead>
                <tbody>
                  {state.ads.map((ad) => {
                    const busy = busyAdId === ad.adId;
                    const notice = notices[ad.adId];
                    const current = ad.assigneeUserId ?? "";
                    const currentIsActive = !current || state.members.some((member) => member.userId === current);
                    return (
                      <tr key={ad.adId}>
                        <td>
                          <div className="mvp-adrules__ad">
                            <strong title={adLabel(ad)}>{adLabel(ad)}</strong>
                            <span>ID …{ad.adId.slice(-6)}</span>
                          </div>
                        </td>
                        <td className="mvp-adrules__count">{ad.totalLeads}</td>
                        <td>
                          <div className="mvp-settings-select">
                            <select
                              aria-label={`Who receives new leads from ${adLabel(ad)}`}
                              value={current}
                              disabled={busy}
                              onChange={(event) => void changeAssignee(ad, state.members, event.target.value)}
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
                            {ad.assigneeUserId && ad.unassignedLeads > 0 ? (
                              <button
                                type="button"
                                className="mvp-task-button"
                                disabled={busy}
                                onClick={() => void assignExisting(ad, state.members)}
                              >
                                {busy ? "Working…" : `Assign ${ad.unassignedLeads} unassigned`}
                              </button>
                            ) : (
                              <span className="mvp-adrules__muted">
                                {ad.unassignedLeads === 0 ? "All leads assigned" : `${ad.unassignedLeads} unassigned`}
                              </span>
                            )}
                            {notice ? (
                              <span className={`mvp-adrules__notice mvp-adrules__notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
                                {notice.text}
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
    </section>
  );
}

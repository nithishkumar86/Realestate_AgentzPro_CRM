"use client";

import Script from "next/script";
import { Check, Loader2, Plug, RefreshCw, Unplug, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { EmptyState, LoadingState, Notice, PageHeader, StatusBadge, displayValue } from "@/components/ui";
import { formatDateTime } from "@/lib/date-utils";
import type { ConnectionAction, ConnectionOverview, EligibleFacebookPage, FacebookPageConnection } from "@/lib/types";
import { connectSelectedPages, disconnectFacebookPage, disconnectMetaConnection, getConnectionOverview, startMetaConnection } from "@/services/crm-api-client";

type ActionName = ConnectionAction | "select" | "disconnect_all";
type ActionState = { action: ActionName; pageId?: string } | null;

const facebookLoginConfigId = process.env.NEXT_PUBLIC_META_LOGIN_CONFIG_ID;

export function ConnectionPageClient() {
  const [overview, setOverview] = useState<ConnectionOverview | null>(null);
  const [eligiblePages, setEligiblePages] = useState<EligibleFacebookPage[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const [isSdkReady, setIsSdkReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [actionState, setActionState] = useState<ActionState>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    void getConnectionOverview()
      .then((data) => { if (active) setOverview(data); })
      .catch((error: unknown) => { if (active) setMessage({ tone: "danger", text: getErrorMessage(error, "Connection details could not be loaded. Try again.") }); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, []);

  const activeConnectionId = useMemo(() => overview?.pages.find((page) => page.status !== "disconnected")?.connectionId ?? null, [overview]);
  const isConnecting = actionState?.action === "connect";
  const hasConnectedPages = Boolean(overview?.pages.some((page) => page.status !== "disconnected"));

  async function handleConnect(): Promise<void> {
    if (!facebookLoginConfigId || !window.FB) {
      setMessage({ tone: "danger", text: "Facebook authorization is not available. Verify the public Meta configuration." });
      return;
    }
    try {
      setActionState({ action: "connect" });
      setMessage(null);
      const result = await startMetaConnection(await requestFacebookAccessToken(facebookLoginConfigId));
      setConnectionId(result.connectionId);
      setEligiblePages(result.pages);
      setSelectedPageIds(result.pages.map((page) => page.facebookPageId));
      if (result.pages.length === 0) setMessage({ tone: "danger", text: "No eligible Facebook Pages were found for this account." });
    } catch (error) {
      setMessage({ tone: "danger", text: getErrorMessage(error, "Facebook authorization could not be completed.") });
    } finally {
      setActionState(null);
    }
  }

  async function handleSelectedPagesConnect(): Promise<void> {
    if (!connectionId || selectedPageIds.length === 0) {
      setMessage({ tone: "danger", text: "Select at least one Facebook Page." });
      return;
    }
    try {
      setActionState({ action: "select" });
      setOverview(await connectSelectedPages(connectionId, selectedPageIds));
      clearPageSelection();
      setMessage({ tone: "success", text: "Selected Facebook Pages are connected." });
    } catch (error) {
      setMessage({ tone: "danger", text: getErrorMessage(error, "Selected Facebook Pages could not be connected.") });
    } finally {
      setActionState(null);
    }
  }

  async function handlePageAction(action: ConnectionAction, page?: FacebookPageConnection): Promise<void> {
    if (action === "connect" || action === "reconnect") return handleConnect();
    if (!page || !window.confirm(`Disconnect ${page.pageName}?`)) return;
    try {
      setActionState({ action, pageId: page.id });
      setOverview(await disconnectFacebookPage(page.id));
      setMessage({ tone: "success", text: "Facebook Page disconnected locally." });
    } catch (error) {
      setMessage({ tone: "danger", text: getErrorMessage(error, "Facebook Page could not be disconnected.") });
    } finally {
      setActionState(null);
    }
  }

  async function handleDisconnectAll(): Promise<void> {
    if (!activeConnectionId || !window.confirm("Disconnect this Facebook connection and all of its Pages?")) return;
    try {
      setActionState({ action: "disconnect_all" });
      setOverview(await disconnectMetaConnection(activeConnectionId));
      setMessage({ tone: "success", text: "Facebook connection disconnected locally." });
    } catch (error) {
      setMessage({ tone: "danger", text: getErrorMessage(error, "Facebook connection could not be disconnected.") });
    } finally {
      setActionState(null);
    }
  }

  function togglePageSelection(pageId: string): void {
    setSelectedPageIds((current) => current.includes(pageId) ? current.filter((id) => id !== pageId) : [...current, pageId]);
  }

  function clearPageSelection(): void { setEligiblePages([]); setConnectionId(null); setSelectedPageIds([]); }

  return <div className="stack">
    <Script src="https://connect.facebook.net/en_US/sdk.js" strategy="afterInteractive" onLoad={() => setIsSdkReady(true)} onError={() => setMessage({ tone: "danger", text: "Facebook authorization could not be loaded." })} />
    <PageHeader title="Connection" description="Manage the Facebook Pages that will receive Meta Lead Ads leads." />
    {message ? <Notice tone={message.tone} title={message.text} /> : null}
    {isLoading ? <LoadingState label="Loading connection details" /> : null}
    {!isLoading && !hasConnectedPages ? <EmptyState title="No Facebook Page connected" description="Connect your Facebook account and select the Page from which you want to receive leads." action={<ConnectButton isReady={isSdkReady} isProcessing={isConnecting} onClick={() => void handlePageAction("connect")} />} /> : null}
    {!isLoading && overview ? <>
      <section className="panel"><div className="panel__body"><div className="section-title"><div><h2>Connection summary</h2><p>Page IDs are masked and credential details are never shown.</p></div><div className="button-group"><ConnectButton isReady={isSdkReady} isProcessing={isConnecting} onClick={() => void handlePageAction("connect")} />{activeConnectionId ? <button className="button button--danger" type="button" onClick={() => void handleDisconnectAll()} disabled={actionState?.action === "disconnect_all"}>{actionState?.action === "disconnect_all" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Unplug aria-hidden="true" size={18} />}Disconnect all</button> : null}</div></div><div className="meta-list"><div className="meta-item"><span>Status</span><strong><ConnectionStatusBadge status={overview.connectionStatus} /></strong></div><div className="meta-item"><span>Connected Pages</span><strong>{overview.pages.filter((page) => page.status !== "disconnected").length}</strong></div></div></div></section>
      {eligiblePages.length > 0 ? <section className="panel"><div className="panel__body stack"><div className="section-title"><div><h2>Choose Facebook Pages</h2><p>Only Pages with advertising access can be connected.</p></div></div><div className="selection-list">{eligiblePages.map((page) => <label className="selection-list__item" key={page.facebookPageId}><input type="checkbox" checked={selectedPageIds.includes(page.facebookPageId)} onChange={() => togglePageSelection(page.facebookPageId)} /><span><strong>{page.facebookPageName}</strong><small>•••• {page.pageIdLastFour}</small></span>{selectedPageIds.includes(page.facebookPageId) ? <Check aria-hidden="true" size={18} /> : null}</label>)}</div><div className="button-group"><button className="button" type="button" onClick={() => void handleSelectedPagesConnect()} disabled={actionState?.action === "select" || selectedPageIds.length === 0}>{actionState?.action === "select" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Plug aria-hidden="true" size={18} />}Connect selected Pages</button><button className="button button--secondary" type="button" onClick={clearPageSelection}><X aria-hidden="true" size={18} />Cancel</button></div></div></section> : null}
      {overview.pages.length > 0 ? <ConnectedPages overview={overview} actionState={actionState} onAction={handlePageAction} /> : null}
    </> : null}
  </div>;
}

function ConnectedPages({ overview, actionState, onAction }: { overview: ConnectionOverview; actionState: ActionState; onAction: (action: ConnectionAction, page?: FacebookPageConnection) => Promise<void> }) {
  return <section className="panel"><div className="panel__body"><div className="section-title"><div><h2>Connected Pages</h2></div></div><table className="data-table"><thead><tr><th>Facebook Page</th><th>Category</th><th>Page ID</th><th>Status</th><th>Last connected</th><th>Action</th></tr></thead><tbody>{overview.pages.map((page) => <tr key={page.id}><td className="truncate" title={page.pageName}>{page.pageName}</td><td>{displayValue(page.category)}</td><td>•••• {page.pageIdLastFour}</td><td><ConnectionStatusBadge status={page.status} /></td><td>{formatDateTime(page.lastConnectedAt)}</td><td><PageAction page={page} actionState={actionState} onAction={onAction} /></td></tr>)}</tbody></table><div className="lead-card-list">{overview.pages.map((page) => <article className="lead-card" key={page.id}><div className="lead-card__top"><strong>{page.pageName}</strong><ConnectionStatusBadge status={page.status} /></div><span>{displayValue(page.category)}</span><span>•••• {page.pageIdLastFour}</span><span>{formatDateTime(page.lastConnectedAt)}</span><PageAction page={page} actionState={actionState} onAction={onAction} /></article>)}</div></div></section>;
}

function ConnectButton({ isReady, isProcessing, onClick }: { isReady: boolean; isProcessing: boolean; onClick: () => void }) { return <button className="button" type="button" onClick={onClick} disabled={!isReady || isProcessing}>{isProcessing ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Plug aria-hidden="true" size={18} />}Connect Facebook</button>; }
function ConnectionStatusBadge({ status }: { status: ConnectionOverview["connectionStatus"] }) { const labels: Record<ConnectionOverview["connectionStatus"], string> = { active: "Active", reauthorization_required: "Reauthorization required", disconnected: "Disconnected", not_connected: "Not connected" }; const tones: Record<ConnectionOverview["connectionStatus"], "success" | "warning" | "info"> = { active: "success", reauthorization_required: "warning", disconnected: "info", not_connected: "info" }; return <StatusBadge tone={tones[status]}>{labels[status]}</StatusBadge>; }
function PageAction({ page, actionState, onAction }: { page: FacebookPageConnection; actionState: ActionState; onAction: (action: ConnectionAction, page: FacebookPageConnection) => Promise<void> }) { const processing = actionState?.pageId === page.id; if (page.status === "reauthorization_required") return <button className="button button--secondary" type="button" disabled={processing} onClick={() => void onAction("reconnect", page)}>{processing ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <RefreshCw aria-hidden="true" size={18} />}Reconnect</button>; if (page.status === "active") return <button className="button button--danger" type="button" disabled={processing} onClick={() => void onAction("disconnect", page)}>{processing ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Unplug aria-hidden="true" size={18} />}Disconnect</button>; return <span className="field-help">No action</span>; }
function requestFacebookAccessToken(configId: string): Promise<string> { return new Promise((resolve, reject) => window.FB?.login((response) => response.authResponse?.accessToken ? resolve(response.authResponse.accessToken) : reject(new Error("Facebook authorization was cancelled or denied.")), { config_id: configId, response_type: "token", override_default_response_type: true })); }
function getErrorMessage(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }

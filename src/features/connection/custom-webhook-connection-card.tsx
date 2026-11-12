"use client";

import { Check, Copy, Eye, EyeOff, KeyRound, Loader2, RefreshCw, Unplug, Webhook, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { LoadingState, Notice, StatusBadge } from "@/components/ui";
import { IntegrationCardTitle } from "@/features/connection/integration-card-title";
import { formatDateTime } from "@/lib/date-utils";
import { createCustomWebhook, getCustomWebhookOverview, stopCustomWebhook, type CustomWebhookOverview } from "@/services/crm-api-client";

type Busy = "create" | "replace" | "stop" | null;

/** What a tool sends: the fields the webhook reads by name. Any other field is saved with the lead as it is. */
export const SAMPLE_WEBHOOK_BODY = JSON.stringify({
  name: "John Doe",
  phone: "9876543210",
  email: "john@example.com",
  source: "Landing Page",
  lead_id: "optional-your-own-id",
}, null, 2);

/**
 * Webhook on the Connection page: one secret URL per company that any tool able to send a POST request (website form
 * plugins, Zapier, Pabbly, the company's own software) uses to send leads. The URL is the only secret, so it is shown
 * only to the owner, hidden until asked, and must never go into a website's HTML or JavaScript.
 */
export function CustomWebhookConnectionCard() {
  const [overview, setOverview] = useState<CustomWebhookOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [stoppedNotice, setStoppedNotice] = useState(false);
  const [copied, setCopied] = useState<"url" | "sample" | null>(null);
  const [showUrl, setShowUrl] = useState(false);
  const urlInputId = useId();

  useEffect(() => {
    let active = true;
    void getCustomWebhookOverview({ details: true })
      .then((data) => { if (active) setOverview(data); })
      .catch((error: unknown) => { if (active) setMessage({ tone: "danger", text: errorText(error, "Webhook details could not be loaded. Try again.") }); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, []);

  async function reload(): Promise<void> {
    setOverview(await getCustomWebhookOverview({ details: true }));
  }

  async function run(action: Exclude<Busy, null>, task: () => Promise<void>): Promise<void> {
    setBusy(action);
    setMessage(null);
    try {
      await task();
    } catch (error) {
      setMessage({ tone: "danger", text: errorText(error, "The request could not be completed. Try again.") });
    } finally {
      setBusy(null);
    }
  }

  async function copy(kind: "url" | "sample", value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setMessage({ tone: "warning", text: "Copy did not work in this browser. Select the text and copy it instead." });
    }
  }

  const canManage = overview?.canManage === true;
  const webhook = overview?.webhook ?? null;

  return <section className="panel integration-card integration-card--webhook" aria-labelledby="custom-webhook-title"><div className="panel__body stack">
    <div className="section-title"><IntegrationCardTitle id="custom-webhook-title" icon={Webhook} title="Webhook" description="Receive leads from any tool that can send a POST request: website form plugins, Zapier, Pabbly or your own software." />
      {overview ? <StatusBadge tone={overview.hasWebhook ? "success" : overview.webhookStopped ? "danger" : "info"}>{overview.hasWebhook ? "Receiving leads" : overview.webhookStopped ? "Disconnected" : "Not set up"}</StatusBadge> : null}
    </div>
    {message ? <Notice tone={message.tone} title={message.text} /> : null}
    {isLoading ? <LoadingState label="Loading webhook details" /> : null}
    {overview && !canManage ? <Notice tone="info" title="Only the company owner can set up the webhook." /> : null}
    {overview && canManage ? <div className="google-ads-step">
      {webhook ? <>
        <p className="field-help">Paste this URL into a tool that sends leads from its own server, such as Zapier, Pabbly, your CRM or a WordPress / Elementor webhook action. Method: <strong>POST</strong>, as JSON or form data.</p>
        <p className="field-help"><strong>Keep this URL secret.</strong> Never put it in your website&apos;s HTML or JavaScript: anyone who has it can send leads. Leads sent from a web page are refused.</p>
        <div className="field"><label htmlFor={urlInputId}>Webhook URL</label>
          <div className="google-copy-row"><input id={urlInputId} type={showUrl ? "text" : "password"} autoComplete="off" readOnly value={webhook.url} onFocus={(event) => event.currentTarget.select()} />
            <button className="google-copy-row__action" type="button" aria-pressed={showUrl} onClick={() => setShowUrl((current) => !current)}>{showUrl ? <EyeOff aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}{showUrl ? "Hide" : "Show"}</button>
            <button className={`google-copy-row__action${copied === "url" ? " google-copy-row__action--done" : ""}`} type="button" onClick={() => void copy("url", webhook.url)}>{copied === "url" ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}{copied === "url" ? "Copied" : "Copy"}</button></div></div>
        <div className="field"><span className="webhook-sample__label">Example body</span>
          <div className="webhook-sample">
            <pre aria-label="Example webhook body">{SAMPLE_WEBHOOK_BODY}</pre>
            <button className={`google-copy-row__action${copied === "sample" ? " google-copy-row__action--done" : ""}`} type="button" onClick={() => void copy("sample", SAMPLE_WEBHOOK_BODY)}>{copied === "sample" ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}{copied === "sample" ? "Copied" : "Copy"}</button>
          </div>
          <p className="field-help">Phone or email is required. Any other field, such as city or budget, is saved with the lead. A lead sent again with the same lead_id is not saved twice.</p>
        </div>
        {webhook.lastLeadAt ? <div className="google-arrival">
          <strong className="google-arrival__status">Leads arriving<Check aria-hidden="true" size={18} /></strong>
          <span className="field-help">Last lead {formatDateTime(webhook.lastLeadAt)}</span>
        </div> : <div className="meta-list"><div className="meta-item"><span>Last lead</span><strong>None yet</strong></div></div>}
        <div className="button-group">
          {confirmReplace ? <>
            <span className="field-help">The old URL stops working at once. Paste the new URL into every tool that sends leads.</span>
            <button className="button button--danger" type="button" disabled={busy === "replace"} onClick={() => void run("replace", async () => { await createCustomWebhook(); await reload(); setConfirmReplace(false); setShowUrl(false); setMessage({ tone: "success", text: "New URL created. Paste it into your tools." }); })}>{busy === "replace" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <RefreshCw aria-hidden="true" size={18} />}Replace URL</button>
            <button className="button button--secondary" type="button" onClick={() => setConfirmReplace(false)}><X aria-hidden="true" size={18} />Cancel</button>
          </> : <button className="button button--secondary" type="button" onClick={() => setConfirmReplace(true)}><RefreshCw aria-hidden="true" size={18} />Replace URL</button>}
        </div>
        <div className="button-group">
          <button className="button button--danger" type="button" disabled={busy === "stop"} onClick={() => void run("stop", async () => { await stopCustomWebhook(); setConfirmReplace(false); await reload(); setStoppedNotice(true); })}>{busy === "stop" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Unplug aria-hidden="true" size={18} />}Stop receiving webhook leads</button>
        </div>
      </> : overview.webhookStopped ? <>
        <p className="google-stopped">Lead arrival stopped<X aria-hidden="true" size={18} /></p>
        <p className="field-help">To reconnect, create a new webhook URL and paste it into your tools.</p>
        <div className="button-group"><button className="button" type="button" disabled={busy === "create"} onClick={() => void run("create", async () => { await createCustomWebhook(); await reload(); setMessage({ tone: "success", text: "New webhook URL created. Paste it into your tools." }); })}>{busy === "create" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <KeyRound aria-hidden="true" size={18} />}Create new webhook URL</button></div>
      </> : <>
        <p className="field-help">Create a webhook URL, then paste it into the tool that should send leads to AgentzPro.</p>
        <div className="button-group"><button className="button" type="button" disabled={busy === "create"} onClick={() => void run("create", async () => { await createCustomWebhook(); await reload(); })}>{busy === "create" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <KeyRound aria-hidden="true" size={18} />}Create webhook URL</button></div>
      </>}
      {stoppedNotice ? <WebhookStoppedPopup onOk={() => setStoppedNotice(false)} /> : null}
    </div> : null}
  </div></section>;
}

/** Shown once webhook leads are stopped (the app's pop-up look, OK only). */
function WebhookStoppedPopup({ onOk }: { onOk: () => void }) {
  const titleId = useId();
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { okRef.current?.focus(); }, []);
  return <div className="mvp-invite-popup__backdrop" onKeyDown={(event) => { if (event.key === "Escape") onOk(); }}>
    <div className="mvp-invite-popup" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
      <span className="mvp-invite-popup__icon google-stop-popup__icon" aria-hidden="true"><Unplug size={28} /></span>
      <h4 id={titleId}>Webhook leads stopped</h4>
      <p>AgentzPro now refuses leads sent to this webhook URL. Remove the URL from your tools.</p>
      <button type="button" className="mvp-invite-popup__ok" ref={okRef} onClick={onOk}>OK</button>
    </div>
  </div>;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

"use client";

import { Check, Copy, Eye, EyeOff, KeyRound, Loader2, RefreshCw, Unplug, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { LoadingState, Notice, StatusBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/date-utils";
import {
  createGoogleAdsWebhook, disconnectGoogleAds, getGoogleAdsAccountOptions, getGoogleAdsOverview, saveGoogleAdsAccounts,
  type GoogleAdsAccountOption, type GoogleAdsOverview,
} from "@/services/crm-api-client";

type Busy = "webhook" | "accounts" | "save" | "disconnect" | null;

// Shown once after Google's redirect back to /connection?google=<result>.
const CALLBACK_MESSAGES: Record<string, { tone: "success" | "danger" | "warning"; text: string }> = {
  connected: { tone: "success", text: "Google Ads is connected. Choose the accounts your lead forms run in." },
  denied: { tone: "warning", text: "Google sign-in was cancelled. Nothing was connected." },
  scope_missing: { tone: "warning", text: "Google Ads access was not ticked on the Google screen, so nothing was connected. Try again and allow Google Ads." },
  failed: { tone: "danger", text: "Google sign-in could not be completed. Try again." },
};

/**
 * Google Ads on the Connection page. Two independent parts:
 * 1. Lead form webhook: the URL and key the owner pastes into each Google Ads lead form. This alone delivers leads.
 * 2. Google sign-in (read-only): used only to show which campaign each lead came from.
 */
export function GoogleAdsConnectionCard() {
  const [overview, setOverview] = useState<GoogleAdsOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);
  const [accountOptions, setAccountOptions] = useState<GoogleAdsAccountOption[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [copied, setCopied] = useState<"url" | "key" | null>(null);
  // The key is a secret: hidden like a password until the owner chooses to show it. Copy works either way.
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("google");
    const callbackMessage = result ? CALLBACK_MESSAGES[result] ?? null : null;
    if (callbackMessage) window.history.replaceState(null, "", window.location.pathname);
    let active = true;
    void getGoogleAdsOverview()
      .then((data) => { if (active) { setOverview(data); setMessage(callbackMessage); } })
      .catch((error: unknown) => { if (active) setMessage({ tone: "danger", text: errorText(error, "Google Ads details could not be loaded. Try again.") }); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, []);

  async function reload(): Promise<void> {
    setOverview(await getGoogleAdsOverview());
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

  async function copy(kind: "url" | "key", value: string): Promise<void> {
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

  return <section className="panel" aria-labelledby="google-ads-title"><div className="panel__body stack">
    <div className="section-title"><div><h2 id="google-ads-title">Google Ads</h2><p>Receive leads from your Google Ads lead forms.</p></div>
      {overview ? <StatusBadge tone={overview.hasWebhook ? "success" : "info"}>{overview.hasWebhook ? "Receiving leads" : "Not set up"}</StatusBadge> : null}
    </div>
    {message ? <Notice tone={message.tone} title={message.text} /> : null}
    {isLoading ? <LoadingState label="Loading Google Ads details" /> : null}
    {overview && !canManage ? <Notice tone="info" title="Only the company owner can set up Google Ads." /> : null}
    {overview && canManage ? <>
      <div className="google-ads-step">
        <h3>1. Lead form webhook</h3>
        <p className="field-help">In Google Ads, open each lead form, go to Lead delivery → Webhook integration, and paste this URL and key. Then select Send test data.</p>
        {webhook ? <>
          <div className="field"><label htmlFor="google-webhook-url">Webhook URL</label>
            <div className="google-copy-row"><input id="google-webhook-url" readOnly value={webhook.url} onFocus={(event) => event.currentTarget.select()} />
              <button className="button button--secondary" type="button" onClick={() => void copy("url", webhook.url)}>{copied === "url" ? <Check aria-hidden="true" size={18} /> : <Copy aria-hidden="true" size={18} />}{copied === "url" ? "Copied" : "Copy"}</button></div></div>
          <div className="field"><label htmlFor="google-webhook-key">Key</label>
            <div className="google-copy-row"><input id="google-webhook-key" type={showKey ? "text" : "password"} autoComplete="off" readOnly value={webhook.key} onFocus={(event) => event.currentTarget.select()} />
              <button className="button button--secondary" type="button" aria-pressed={showKey} onClick={() => setShowKey((current) => !current)}>{showKey ? <EyeOff aria-hidden="true" size={18} /> : <Eye aria-hidden="true" size={18} />}{showKey ? "Hide" : "Show"}</button>
              <button className="button button--secondary" type="button" onClick={() => void copy("key", webhook.key)}>{copied === "key" ? <Check aria-hidden="true" size={18} /> : <Copy aria-hidden="true" size={18} />}{copied === "key" ? "Copied" : "Copy"}</button></div></div>
          <div className="meta-list">
            <div className="meta-item"><span>Test lead</span><strong>{webhook.lastTestAt ? `Received ✓ ${formatDateTime(webhook.lastTestAt)}` : "Not received yet"}</strong></div>
            <div className="meta-item"><span>Last lead</span><strong>{webhook.lastLeadAt ? formatDateTime(webhook.lastLeadAt) : "None yet"}</strong></div>
          </div>
          <div className="button-group">
            {confirmRotate ? <>
              <span className="field-help">The old key stops working at once. Any lead a form sends before you paste the new key into it is lost; Google does not resend it.</span>
              <button className="button button--danger" type="button" disabled={busy === "webhook"} onClick={() => void run("webhook", async () => { await createGoogleAdsWebhook(); await reload(); setConfirmRotate(false); setMessage({ tone: "success", text: "New key created. Paste it into your Google Ads lead forms." }); })}>{busy === "webhook" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <RefreshCw aria-hidden="true" size={18} />}Replace key</button>
              <button className="button button--secondary" type="button" onClick={() => setConfirmRotate(false)}><X aria-hidden="true" size={18} />Cancel</button>
            </> : <button className="button button--secondary" type="button" onClick={() => setConfirmRotate(true)}><RefreshCw aria-hidden="true" size={18} />Replace key</button>}
          </div>
        </> : <div className="button-group"><button className="button" type="button" disabled={busy === "webhook"} onClick={() => void run("webhook", async () => { await createGoogleAdsWebhook(); await reload(); })}>{busy === "webhook" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <KeyRound aria-hidden="true" size={18} />}Create webhook URL and key</button></div>}
      </div>

      <div className="google-ads-step">
        <h3>2. Campaign names (optional)</h3>
        <p className="field-help">Sign in with Google so each lead shows the campaign it came from. AgentzPro CRM only reads your campaign and ad group names; it never changes your campaigns, budgets or billing. <Link href="/privacy-policy">Privacy Policy</Link></p>
        {overview.needsReconnect ? <Notice tone="warning" title="Google stopped accepting this sign-in. Sign in with Google again so campaign names keep loading." /> : null}
        {overview.connection ? <>
          <div className="meta-list">
            <div className="meta-item"><span>Google account</span><strong>{overview.connection.email}</strong></div>
            <div className="meta-item"><span>Connected</span><strong>{formatDateTime(overview.connection.connectedAt)}</strong></div>
            <div className="meta-item"><span>Ads accounts</span><strong>{overview.linkedAccounts.length > 0 ? overview.linkedAccounts.map((account) => account.name ?? formatCustomerId(account.customerId)).join(", ") : "None chosen"}</strong></div>
          </div>
          {accountOptions ? <div className="stack">
            {accountOptions.length === 0 ? <p className="field-help">This Google account has no Google Ads accounts it can open.</p> : <div className="google-account-list">{accountOptions.map((account) => <label className="google-account-list__item" key={account.customerId}>
              <input type="checkbox" checked={selected.includes(account.customerId)} onChange={() => setSelected((current) => current.includes(account.customerId) ? current.filter((id) => id !== account.customerId) : [...current, account.customerId])} />
              <span><strong>{account.name ?? "Unnamed account"}</strong><small>{formatCustomerId(account.customerId)}{account.loginCustomerId ? ` · via manager ${formatCustomerId(account.loginCustomerId)}` : ""}</small></span>
            </label>)}</div>}
            <div className="button-group">
              <button className="button" type="button" disabled={busy === "save"} onClick={() => void run("save", async () => { await saveGoogleAdsAccounts(selected); setAccountOptions(null); await reload(); setMessage({ tone: "success", text: "Google Ads accounts saved." }); })}>{busy === "save" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Check aria-hidden="true" size={18} />}Save accounts</button>
              <button className="button button--secondary" type="button" onClick={() => setAccountOptions(null)}><X aria-hidden="true" size={18} />Cancel</button>
            </div>
          </div> : null}
          <div className="button-group">
            {!accountOptions ? <button className="button button--secondary" type="button" disabled={busy === "accounts"} onClick={() => void run("accounts", async () => { const { accounts } = await getGoogleAdsAccountOptions(); setAccountOptions(accounts); setSelected(accounts.filter((account) => account.selected).map((account) => account.customerId)); })}>{busy === "accounts" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Check aria-hidden="true" size={18} />}Choose accounts</button> : null}
            {overview.needsReconnect ? <GoogleSignInButton /> : null}
            {confirmDisconnect ? <>
              <span className="field-help">Leads keep arriving; new leads will not get campaign names until you sign in again.</span>
              <button className="button button--danger" type="button" disabled={busy === "disconnect"} onClick={() => void run("disconnect", async () => { await disconnectGoogleAds(); setConfirmDisconnect(false); setAccountOptions(null); await reload(); setMessage({ tone: "success", text: "Google sign-in removed. Leads keep arriving." }); })}>{busy === "disconnect" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Unplug aria-hidden="true" size={18} />}Disconnect Google</button>
              <button className="button button--secondary" type="button" onClick={() => setConfirmDisconnect(false)}><X aria-hidden="true" size={18} />Cancel</button>
            </> : <button className="button button--danger" type="button" onClick={() => setConfirmDisconnect(true)}><Unplug aria-hidden="true" size={18} />Disconnect Google</button>}
          </div>
        </> : <div className="button-group"><GoogleSignInButton /></div>}
      </div>
    </> : null}
  </div></section>;
}

/** Google's branded "Sign in with Google" button (developers.google.com/identity/branding-guidelines). */
function GoogleSignInButton() {
  // A full-page navigation, not fetch: the route answers with a redirect to Google's consent screen.
  return <a className="google-signin-button" href="/api/integrations/google/connect">
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" /><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" /><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" /><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" /></svg>
    <span>Sign in with Google</span>
  </a>;
}

function formatCustomerId(customerId: string): string {
  return /^\d{10}$/.test(customerId) ? `${customerId.slice(0, 3)}-${customerId.slice(3, 6)}-${customerId.slice(6)}` : customerId;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export const INACTIVITY_TIMEOUT_MS = 8 * 60 * 60 * 1000;
export const INACTIVITY_STORAGE_KEY = "agentzpro-inactivity";
const CHANNEL = "agentzpro-inactivity";
const WRITE_INTERVAL_MS = 1000;
const RETRY_MS = 30_000;

interface ActivityRecord {
  startedAt: number;
  lastActivity: number;
  signedOut: boolean;
}

function parseRecord(value: unknown): ActivityRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as ActivityRecord;
  return Number.isFinite(record.startedAt) && record.startedAt > 0 &&
    Number.isFinite(record.lastActivity) && record.lastActivity >= record.startedAt &&
    record.lastActivity <= Date.now() && typeof record.signedOut === "boolean" ? record : null;
}

function readRecord(): ActivityRecord | null {
  try { return parseRecord(JSON.parse(localStorage.getItem(INACTIVITY_STORAGE_KEY) ?? "null")); }
  catch { return null; }
}

function writeRecord(record: ActivityRecord): void {
  try { localStorage.setItem(INACTIVITY_STORAGE_KEY, JSON.stringify(record)); } catch { /* Storage can be disabled. */ }
}

/** UX metadata only. Never reads or writes authentication credentials. */
export function resetInactivityAfterLogin(): void {
  const now = Date.now();
  const record = { startedAt: now, lastActivity: now, signedOut: false };
  writeRecord(record);
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(record);
    channel.close();
  } catch { /* Storage events remain available when BroadcastChannel is unavailable. */ }
}

export interface InactivityOptions {
  onSignedOut: () => void;
  onError: (failed: boolean) => void;
  /** Short durations are injected by tests; the CRM uses the production default. */
  timeoutMs?: number;
}

export function startInactivityTracking({ onSignedOut, onError, timeoutMs = INACTIVITY_TIMEOUT_MS }: InactivityOptions) {
  const now = Date.now();
  let record = readRecord() ?? { startedAt: now, lastActivity: now, signedOut: false };
  let stopped = false;
  let expired = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let channel: BroadcastChannel | undefined;
  let lastWrite = 0;
  let retryAt = 0;
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  let requestController: AbortController | undefined;

  function merge(incoming: ActivityRecord | null): void {
    if (!incoming) return;
    if (incoming.startedAt > record.startedAt) {
      record = incoming;
      expired = false;
      retryAt = 0;
      onError(false);
    } else if (incoming.startedAt === record.startedAt) {
      record = { ...record, lastActivity: Math.max(record.lastActivity, incoming.lastActivity), signedOut: record.signedOut || incoming.signedOut };
    }
  }

  function publish(): void {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    merge(readRecord());
    writeRecord(record);
    lastWrite = Date.now();
    try { channel?.postMessage(record); } catch { /* A closed channel must not affect logout. */ }
  }

  function finish(): void {
    if (stopped) return;
    stop();
    onSignedOut();
  }

  async function logout(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    const attempt = async () => {
      if (stopped) return;
      merge(readRecord());
      if (record.signedOut) { finish(); return; }
      if (!expired && Date.now() - record.lastActivity < timeoutMs) return;
      expired = true;
      const startedAt = record.startedAt;
      requestController = new AbortController();
      requestTimer = setTimeout(() => requestController?.abort(), 15_000);
      let response: Response;
      let body: { signedOut?: boolean };
      try {
        response = await fetch("/api/auth/logout", {
          method: "POST", credentials: "same-origin", signal: requestController.signal,
        });
        body = await response.json();
      } finally {
        clearTimeout(requestTimer);
        requestController = undefined;
      }
      if (!response.ok || body?.signedOut !== true) throw new Error("Logout failed");
      if (stopped) return;
      merge(readRecord());
      // Do not broadcast an old completion over a newer successful login.
      if (record.startedAt !== startedAt) return;
      record = { ...record, lastActivity: record.startedAt, signedOut: true };
      publish();
      finish();
    };
    try {
      if (navigator.locks?.request) await navigator.locks.request(CHANNEL, attempt);
      else await attempt();
    } catch {
      if (!stopped) { retryAt = Date.now() + RETRY_MS; onError(true); }
    } finally {
      inFlight = false;
      if (!stopped) schedule(expired ? RETRY_MS : undefined);
    }
  }

  function schedule(delay?: number): void {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(check, delay ?? Math.max(0, record.lastActivity + timeoutMs - Date.now()));
  }

  function check(): void {
    if (stopped) return;
    merge(readRecord());
    if (record.signedOut) { finish(); return; }
    if (expired && Date.now() < retryAt) { schedule(retryAt - Date.now()); return; }
    if (expired || Date.now() - record.lastActivity >= timeoutMs) { void logout(); return; }
    schedule();
  }

  function activity(): void {
    if (stopped) return;
    merge(readRecord());
    if (record.signedOut || expired || Date.now() - record.lastActivity >= timeoutMs) { check(); return; }
    record.lastActivity = Date.now();
    if (Date.now() - lastWrite >= WRITE_INTERVAL_MS) publish();
    else if (!flushTimer) flushTimer = setTimeout(publish, WRITE_INTERVAL_MS - (Date.now() - lastWrite));
    schedule();
  }

  function receive(value: unknown): void {
    if (stopped) return;
    merge(parseRecord(value));
    check();
  }
  function storage(event: StorageEvent): void {
    if (event.key !== INACTIVITY_STORAGE_KEY) return;
    try { receive(JSON.parse(event.newValue ?? "null")); } catch { /* Ignore malformed metadata. */ }
  }
  function visibility(): void {
    if (document.visibilityState === "hidden") publish();
    check();
  }
  function pageHide(): void { publish(); }
  function retry(): void { retryAt = 0; check(); }
  const events = ["mousemove", "click", "keydown", "scroll", "touchstart", "touchmove"] as const;
  function stop(): void {
    if (stopped) return;
    publish();
    stopped = true;
    clearTimeout(timer);
    clearTimeout(flushTimer);
    clearTimeout(requestTimer);
    requestController?.abort();
    for (const event of events) document.removeEventListener(event, activity, true);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("storage", storage);
    window.removeEventListener("focus", check);
    window.removeEventListener("pageshow", check);
    window.removeEventListener("pagehide", pageHide);
    window.removeEventListener("online", retry);
    channel?.close();
  }

  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent) => receive(event.data);
  } catch { /* Use storage events instead. */ }
  for (const event of events) document.addEventListener(event, activity, { capture: true, passive: true });
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("storage", storage);
  window.addEventListener("focus", check);
  window.addEventListener("pageshow", check);
  window.addEventListener("pagehide", pageHide);
  window.addEventListener("online", retry);
  publish();
  check();
  return { activity, stop, retry };
}

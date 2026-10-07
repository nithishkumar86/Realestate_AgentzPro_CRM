import "server-only";

import webpush from "web-push";
import { AppError } from "@/lib/server/app-error";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import type { TenantRequestContext } from "@/lib/server/tenant-context";

export interface PushSubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string } }
export interface ReminderRow { id: string; tenant_id: string; user_id: string; task_id: string; lead_id: string; kind: string }

// The server later POSTs to this URL, so it must be a real browser push service and nothing else (no SSRF).
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function isPushServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username && !url.password && PUSH_HOSTS.some((pattern) => pattern.test(url.hostname));
  } catch {
    return false;
  }
}

let configured: boolean | undefined;

/** Web Push is optional: without the VAPID env vars the in-app alerts still work and push is skipped. */
function configurePush(): boolean {
  if (configured !== undefined) return configured;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  configured = Boolean(publicKey && privateKey);
  if (configured) webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:support@agentzpro.com", publicKey!, privateKey!);
  return configured;
}

/** Saves this browser's push endpoint for the signed-in member (the same endpoint is re-claimed by whoever subscribes last). */
export async function savePushSubscription(context: TenantRequestContext, input: PushSubscriptionInput): Promise<void> {
  const { error } = await getSupabaseAdminClient().from("push_subscriptions").upsert({
    tenant_id: context.tenantId, user_id: context.userId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth,
  }, { onConflict: "endpoint" });
  if (error) throw new AppError("Notifications could not be enabled.", { status: 500, code: "PUSH_SAVE_FAILED" });
}

export async function removePushSubscription(context: TenantRequestContext, endpoint: string): Promise<void> {
  const { error } = await getSupabaseAdminClient().from("push_subscriptions").delete()
    .eq("tenant_id", context.tenantId).eq("user_id", context.userId).eq("endpoint", endpoint);
  if (error) throw new AppError("Notifications could not be disabled.", { status: 500, code: "PUSH_REMOVE_FAILED" });
}

/**
 * Sends a push for each alert the worker just created. Never throws: push is best effort and must not fail the
 * reminder run (the alert itself is already stored). Subscriptions the push service reports gone are deleted.
 */
export async function sendReminderPushes(rows: ReminderRow[]): Promise<{ sent: number }> {
  if (rows.length === 0 || !configurePush()) return { sent: 0 };
  const db = getSupabaseAdminClient();
  let sent = 0;
  try {
    const tenantIds = [...new Set(rows.map((row) => row.tenant_id))];
    const userIds = [...new Set(rows.map((row) => row.user_id))];
    const [subs, tasks, leads] = await Promise.all([
      db.from("push_subscriptions").select("tenant_id,user_id,endpoint,p256dh,auth").in("tenant_id", tenantIds).in("user_id", userIds),
      db.from("lead_tasks").select("id,tenant_id,title").in("id", rows.map((row) => row.task_id)),
      db.from("lead_data").select("id,tenant_id,lead_name").in("id", rows.map((row) => row.lead_id)),
    ]);
    if (subs.error || tasks.error || leads.error) return { sent: 0 };
    const titles = new Map((tasks.data ?? []).map((row) => [`${row.tenant_id}:${row.id}`, String(row.title)]));
    const names = new Map((leads.data ?? []).map((row) => [`${row.tenant_id}:${row.id}`, row.lead_name ? String(row.lead_name) : null]));

    const jobs = rows.flatMap((row) => (subs.data ?? [])
      .filter((sub) => sub.tenant_id === row.tenant_id && sub.user_id === row.user_id)
      .map((sub) => {
        const title = titles.get(`${row.tenant_id}:${row.task_id}`) ?? "Task";
        const lead = names.get(`${row.tenant_id}:${row.lead_id}`);
        const payload = JSON.stringify({
          title: `Follow up with ${lead ?? "this lead"} ${row.kind === "due_now" ? "now" : "in 15 min"}`,
          body: title, url: "/tasks", tag: row.id,
        });
        return webpush.sendNotification({ endpoint: String(sub.endpoint), keys: { p256dh: String(sub.p256dh), auth: String(sub.auth) } }, payload)
          .then(() => { sent += 1; })
          .catch(async (error: { statusCode?: number }) => {
            if (error.statusCode === 404 || error.statusCode === 410) await db.from("push_subscriptions").delete().eq("endpoint", String(sub.endpoint));
          });
      }));
    await Promise.all(jobs);
  } catch {
    console.error(JSON.stringify({ operation: "task_reminder_push", code: "PUSH_FAILED" }));
  }
  return { sent };
}

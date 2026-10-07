/**
 * Creates (or updates) the QStash schedule that fires the task reminder worker every minute.
 *
 * Run it only AFTER the app (with /api/queues/tasks/reminders) is deployed, and check the QStash daily
 * message quota first: a per-minute schedule is about 1,440 messages a day.
 * QStash signs its requests, so the worker's signature check authenticates them. A fixed scheduleId makes
 * this script idempotent: re-running it updates the schedule in place. Run with:
 *   node --env-file=.env.local scripts/ensure-task-reminder-schedule.mjs
 */
import { Client } from "@upstash/qstash";

const SCHEDULE_ID = "task-reminders";
const REMINDERS_PATH = "/api/queues/tasks/reminders";
// Every minute: the 15-minute and due-time alerts are never more than a minute late.
const CRON_EXPRESSION = "* * * * *";

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`${name} is not set. Run with: node --env-file=.env.local scripts/ensure-task-reminder-schedule.mjs`);
  }
  return value.trim();
}

function buildRemindersUrl(callbackUrl) {
  const url = new URL(callbackUrl);
  if (url.protocol !== "https:") {
    throw new Error("META_WEBHOOK_CALLBACK_URL must use HTTPS.");
  }
  url.pathname = REMINDERS_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function main() {
  const destination = buildRemindersUrl(requireEnv("META_WEBHOOK_CALLBACK_URL"));
  const client = new Client({ token: requireEnv("QSTASH_TOKEN") });

  const { scheduleId } = await client.schedules.create({
    scheduleId: SCHEDULE_ID,
    destination,
    cron: CRON_EXPRESSION,
    method: "POST",
    body: JSON.stringify({}),
    headers: { "content-type": "application/json" },
    retries: 1,
  });

  console.log(`Task reminder schedule ready: id=${scheduleId} cron="${CRON_EXPRESSION}" destination=${destination}`);
}

main().catch((error) => {
  console.error(`Failed to configure the task reminder schedule: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

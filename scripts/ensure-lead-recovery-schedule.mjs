/**
 * Creates (or updates) the QStash schedule that drives the Meta lead recovery worker.
 *
 * Without this schedule nothing ever calls /api/queues/meta/recovery, and because the retrieval worker
 * answers 200 after recording a failure, QStash's own per-message retries never fire either. That left
 * every 'retry_scheduled' event, every undispatched 'pending' event and every lease-expired 'processing'
 * event stranded forever. This schedule is what makes the retry and recovery logic actually run.
 *
 * QStash signs its requests, so the worker's existing signature check authenticates them and no new
 * secret is introduced. Passing a fixed scheduleId makes this script idempotent: re-running it updates
 * the existing schedule in place instead of creating duplicates.
 *
 * Run after deploying, and again whenever META_WEBHOOK_CALLBACK_URL changes:
 *   node --env-file=.env.local scripts/ensure-lead-recovery-schedule.mjs
 */
import { Client } from "@upstash/qstash";

const SCHEDULE_ID = "meta-lead-recovery";
const RECOVERY_PATH = "/api/queues/meta/recovery";
// Every minute. The retrieval backoff starts at 30s, so a coarser cadence would add avoidable latency
// to the first retry of every transiently failed lead.
const CRON_EXPRESSION = "* * * * *";

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`${name} is not set. Run with: node --env-file=.env.local scripts/ensure-lead-recovery-schedule.mjs`);
  }
  return value.trim();
}

function buildRecoveryUrl(callbackUrl) {
  const url = new URL(callbackUrl);
  if (url.protocol !== "https:") {
    throw new Error("META_WEBHOOK_CALLBACK_URL must use HTTPS.");
  }
  url.pathname = RECOVERY_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function main() {
  const destination = buildRecoveryUrl(requireEnv("META_WEBHOOK_CALLBACK_URL"));
  const client = new Client({ token: requireEnv("QSTASH_TOKEN") });

  const { scheduleId } = await client.schedules.create({
    scheduleId: SCHEDULE_ID,
    destination,
    cron: CRON_EXPRESSION,
    method: "POST",
    body: JSON.stringify({}),
    headers: { "content-type": "application/json" },
    retries: 3,
  });

  console.log(`Lead recovery schedule ready: id=${scheduleId} cron="${CRON_EXPRESSION}" destination=${destination}`);
}

main().catch((error) => {
  console.error(`Failed to configure the lead recovery schedule: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

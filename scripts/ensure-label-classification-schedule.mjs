/**
 * Creates (or updates) the QStash schedule that drives the AI label-classification worker.
 *
 * This is a separate, independent schedule from the existing Meta lead recovery schedule
 * (scripts/ensure-lead-recovery-schedule.mjs) — it does not touch that schedule or the retrieval
 * pipeline. Without this schedule nothing ever calls /api/queues/ai/label-classification, and no
 * lead is ever classified; every lead still gets ingested normally and keeps its default 'Warm'
 * label, since classification is fully decoupled from ingestion.
 *
 * QStash signs its requests, so the worker's existing verifyQstashRequest authenticates them and
 * no new secret is introduced. Passing a fixed scheduleId makes this script idempotent: re-running
 * it updates the existing schedule in place instead of creating duplicates.
 *
 * Run after deploying, and again whenever META_WEBHOOK_CALLBACK_URL changes:
 *   node --env-file=.env.local scripts/ensure-label-classification-schedule.mjs
 */
import { Client } from "@upstash/qstash";

const SCHEDULE_ID = "ai-label-classification";
const CLASSIFICATION_PATH = "/api/queues/ai/label-classification";
// Every minute, matching the existing recovery schedule's cadence.
const CRON_EXPRESSION = "* * * * *";

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`${name} is not set. Run with: node --env-file=.env.local scripts/ensure-label-classification-schedule.mjs`);
  }
  return value.trim();
}

function buildClassificationUrl(callbackUrl) {
  const url = new URL(callbackUrl);
  if (url.protocol !== "https:") {
    throw new Error("META_WEBHOOK_CALLBACK_URL must use HTTPS.");
  }
  url.pathname = CLASSIFICATION_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function main() {
  const destination = buildClassificationUrl(requireEnv("META_WEBHOOK_CALLBACK_URL"));
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

  console.log(`Label classification schedule ready: id=${scheduleId} cron="${CRON_EXPRESSION}" destination=${destination}`);
}

main().catch((error) => {
  console.error(`Failed to configure the label classification schedule: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

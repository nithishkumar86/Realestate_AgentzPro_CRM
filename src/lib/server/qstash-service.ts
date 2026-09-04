import "server-only";

import { Client, Receiver } from "@upstash/qstash";
import { getMetaEnv, getQstashEnv } from "@/lib/server/env";

const LEAD_RETRIEVAL_PATH = "/api/queues/meta/lead-retrieval";
const RECOVERY_PATH = "/api/queues/meta/recovery";
const LEAD_RETRIEVAL_FLOW_CONTROL_KEY = "meta-lead-retrieval";

let qstashClient: Client | undefined;

export type LeadRetrievalJob = { webhook_notification_event_id: string };

export function getLeadRetrievalWorkerUrl(): string {
  return buildInternalUrl(LEAD_RETRIEVAL_PATH);
}

export function getRecoveryWorkerUrl(): string {
  return buildInternalUrl(RECOVERY_PATH);
}

export async function publishLeadRetrievalJob(job: LeadRetrievalJob): Promise<void> {
  await getQstashClient().publishJSON({
    url: getLeadRetrievalWorkerUrl(),
    body: job,
    retries: 3,
    flowControl: { key: LEAD_RETRIEVAL_FLOW_CONTROL_KEY, parallelism: 1 },
  });
}

export async function verifyQstashRequest(request: Request, rawBody: string): Promise<boolean> {
  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return false;
  }

  const environment = getQstashEnv();
  const receiver = new Receiver({
    currentSigningKey: environment.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: environment.QSTASH_NEXT_SIGNING_KEY,
  });

  try {
    return await receiver.verify({ signature, body: rawBody, url: request.url });
  } catch {
    return false;
  }
}

function getQstashClient(): Client {
  if (!qstashClient) {
    qstashClient = new Client({ token: getQstashEnv().QSTASH_TOKEN });
  }
  return qstashClient;
}

function buildInternalUrl(pathname: string): string {
  const callbackUrl = new URL(getMetaEnv().META_WEBHOOK_CALLBACK_URL);
  callbackUrl.pathname = pathname;
  callbackUrl.search = "";
  callbackUrl.hash = "";
  return callbackUrl.toString();
}

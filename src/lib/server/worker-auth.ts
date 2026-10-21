import "server-only";

import { getAuthEnv } from "@/lib/server/env";
import { verifyQstashRequest } from "@/lib/server/qstash-service";
import { isConstantTimeMatch } from "@/lib/server/webhook-security";

const CRON_SECRET_HEADER = "x-cron-secret";

/**
 * Authenticates a call to a scheduled worker route. Two callers are accepted:
 * - Supabase pg_cron (via pg_net), which sends the shared SUBSCRIPTION_CRON_SECRET in `x-cron-secret`,
 *   the same header and secret the /api/cron routes already use.
 * - QStash, which signs its requests (the original path, unchanged).
 *
 * A request that carries `x-cron-secret` is judged on that secret alone and never falls back to the
 * QStash check, so a wrong secret is always rejected. The env is read only on that branch, so the
 * QStash path behaves exactly as before even if the auth env could not be loaded.
 */
export async function isAuthorizedWorkerRequest(request: Request, rawBody: string): Promise<boolean> {
  const suppliedSecret = request.headers.get(CRON_SECRET_HEADER);
  if (suppliedSecret === null) {
    return verifyQstashRequest(request, rawBody);
  }

  try {
    return isConstantTimeMatch(getAuthEnv().SUBSCRIPTION_CRON_SECRET, suppliedSecret);
  } catch {
    console.error(JSON.stringify({ operation: "worker_auth", code: "CRON_SECRET_UNAVAILABLE" }));
    return false;
  }
}

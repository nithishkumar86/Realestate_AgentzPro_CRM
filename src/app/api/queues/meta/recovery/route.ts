import { LeadRecoveryService } from "@/lib/server/lead-recovery-service";
import { isAuthorizedWorkerRequest } from "@/lib/server/worker-auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  if (!(await isAuthorizedWorkerRequest(request, rawBody))) {
    return new Response(null, { status: 403 });
  }

  try {
    await new LeadRecoveryService().recover();
    return new Response(null, { status: 200 });
  } catch {
    console.error(JSON.stringify({ operation: "lead_recovery_worker", code: "RECOVERY_FAILED" }));
    return new Response(null, { status: 500 });
  }
}

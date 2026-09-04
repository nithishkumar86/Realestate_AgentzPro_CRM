import { z } from "zod";
import { LeadRetrievalService } from "@/lib/server/lead-retrieval-service";
import { verifyQstashRequest } from "@/lib/server/qstash-service";

export const runtime = "nodejs";

const leadRetrievalJobSchema = z.object({ webhook_notification_event_id: z.uuid() }).strict();

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  if (!(await verifyQstashRequest(request, rawBody))) {
    return new Response(null, { status: 403 });
  }

  try {
    const job = leadRetrievalJobSchema.parse(JSON.parse(rawBody));
    await new LeadRetrievalService().process(job.webhook_notification_event_id);
    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return new Response(null, { status: 400 });
    }
    console.error(JSON.stringify({ operation: "lead_retrieval_worker", code: "WORKER_FAILED" }));
    return new Response(null, { status: 500 });
  }
}

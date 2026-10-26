import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { CALL_IN_PHONE_MAX_LENGTH, CALL_IN_PHONE_MIN_DIGITS, CALL_IN_TEXT_MAX_LENGTH } from "@/features/leads/lead-options";
import { createTelecallerLead } from "@/lib/server/telecaller-lead-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const phone = z.string().trim().max(CALL_IN_PHONE_MAX_LENGTH).refine((value) => value.replace(/\D/g, "").length >= CALL_IN_PHONE_MIN_DIGITS);
const bodySchema = z.object({
  leadName: z.string().trim().min(1).max(CALL_IN_TEXT_MAX_LENGTH),
  phone,
  whatsapp: z.union([phone, z.literal("")]).optional().transform((value) => value || undefined),
  projectName: z.string().trim().min(1).max(CALL_IN_TEXT_MAX_LENGTH),
}).strict();

// Adds one call-in lead for the signed-in member's company. Any active member may add; the lead is assigned to them.
export async function POST(request: Request) {
  try {
    const input = await parseJsonBody(request, bodySchema);
    const context = await resolveTenantRequestContext();
    return createSuccessResponse(await createTelecallerLead(context, input), 201);
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

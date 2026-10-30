import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { CALL_IN_PHONE_MAX_LENGTH, CALL_IN_PHONE_MIN_DIGITS, CALL_IN_PLATFORMS, CALL_IN_TEXT_MAX_LENGTH } from "@/features/leads/lead-options";
import { createTelecallerLead } from "@/lib/server/telecaller-lead-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const phone = z.string().trim().max(CALL_IN_PHONE_MAX_LENGTH).refine((value) => value.replace(/\D/g, "").length >= CALL_IN_PHONE_MIN_DIGITS);
const bodySchema = z.object({
  leadName: z.string().trim().min(1).max(CALL_IN_TEXT_MAX_LENGTH),
  phone,
  whatsapp: z.union([phone, z.literal("")]).optional().transform((value) => value || undefined),
  projectName: z.string().trim().min(1).max(CALL_IN_TEXT_MAX_LENGTH),
  // Whether the platform is connected, the ad is this company's, and the date is in range is checked by the database.
  cameFromPlatform: z.enum(CALL_IN_PLATFORMS).optional(),
  cameFromRefId: z.string().regex(/^\d{1,40}$/).optional(),
  callDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict().refine((body) => !body.cameFromRefId || body.cameFromPlatform, { path: ["cameFromRefId"] });

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

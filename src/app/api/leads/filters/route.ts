import { z } from "zod";
import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { getLeadFilterOptions } from "@/lib/server/lead-query-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const pageRecordIdSchema = z.string().uuid().optional();

export async function GET(request: Request): Promise<Response> {
  try {
    const pageRecordId = pageRecordIdSchema.parse(new URL(request.url).searchParams.get("pageRecordId") ?? undefined);
    return createSuccessResponse(await getLeadFilterOptions(await resolveTenantRequestContext(), pageRecordId));
  } catch (error) {
    return createErrorResponse(error);
  }
}

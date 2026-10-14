import { z } from "zod";
import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { getLeadFilterOptions } from "@/lib/server/lead-query-service";

const pageRecordIdSchema = z.string().uuid().optional();

export async function GET(request: Request): Promise<Response> {
  try {
    const pageRecordId = pageRecordIdSchema.parse(new URL(request.url).searchParams.get("pageRecordId") ?? undefined);
    const access = await requireCrmAccess();
    return createSuccessResponse(await getLeadFilterOptions(access, access.membershipRole === "owner", pageRecordId));
  } catch (error) {
    return createErrorResponse(error);
  }
}

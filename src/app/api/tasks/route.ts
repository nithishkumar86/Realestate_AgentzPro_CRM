import { z } from "zod";
import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { AppError } from "@/lib/server/app-error";
import { DONE_RANGES, TASK_BUCKETS, getTaskOverview } from "@/lib/server/task-tracking-service";

const querySchema = z.object({
  bucket: z.enum(TASK_BUCKETS).default("today"),
  member: z.string().uuid().optional(),
  range: z.enum(DONE_RANGES).optional(),
  page: z.coerce.number().int().positive().max(1000).optional(),
});

export async function GET(request: Request) {
  try {
    const params = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!params.success) throw new AppError("Request data is invalid.", { status: 400, code: "INVALID_REQUEST" });
    return createSuccessResponse(await getTaskOverview(await requireCrmAccess(), params.data));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

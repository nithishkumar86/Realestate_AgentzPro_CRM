import { AppError } from "@/lib/server/app-error";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rejects a malformed lead id before any database call. */
export function requireLeadId(id: string): string {
  if (!UUID_PATTERN.test(id)) throw new AppError("A valid lead id is required.", { status: 400, code: "INVALID_LEAD_ID" });
  return id;
}

/** Rejects a malformed task id before any database call. */
export function requireTaskId(id: string): string {
  if (!UUID_PATTERN.test(id)) throw new AppError("A valid task id is required.", { status: 400, code: "INVALID_TASK_ID" });
  return id;
}

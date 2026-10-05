import { readError } from "@/features/leads/use-lead-filters";
import type { LeadStatus } from "@/features/leads/lead-options";
import type { LeadTask } from "@/lib/server/lead-timeline-service";

/** Thrown for a failed request, carrying the HTTP status so callers can react to 409 (state changed elsewhere). */
export class LeadRequestError extends Error {
  public readonly status: number;
  public constructor(message: string, status: number) {
    super(message);
    this.name = "LeadRequestError";
    this.status = status;
  }
}

async function send<T>(path: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  const response = await fetch(path, init ? { ...init, headers: { "content-type": "application/json", ...init.headers } } : undefined);
  if (!response.ok) throw new LeadRequestError(await readError(response, fallback), response.status);
  return await response.json() as T;
}

export async function fetchOpenTask(leadId: string): Promise<LeadTask | null> {
  const result = await send<{ openTask: LeadTask | null }>(`/api/leads/${leadId}/tasks`, undefined, "The task could not be loaded.");
  return result.openTask;
}

export async function updateTask(leadId: string, taskId: string, change: { dueDate: string } | { action: "complete" | "cancel" }, fallback: string): Promise<LeadTask> {
  return send<LeadTask>(`/api/leads/${leadId}/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(change) }, fallback);
}

/**
 * Called right after a lead was moved to a final status (Sale, Closed, Disqualified, Archived). A finished
 * lead needs no follow-up, so if it still has an open task the telecaller is asked whether to cancel it.
 * Declining leaves the task open. Returns whether the lead still has an open task afterwards.
 */
export async function offerToCancelOpenTask(leadId: string, status: LeadStatus): Promise<boolean> {
  const openTask = await fetchOpenTask(leadId);
  if (!openTask) return false;
  const cancel = globalThis.confirm(`This lead is now "${status}" but still has an open task "${openTask.title}". Cancel the task now?`);
  if (!cancel) return true;
  await updateTask(leadId, openTask.id, { action: "cancel" }, "The task could not be cancelled.");
  return false;
}

/** Today's calendar date (YYYY-MM-DD) in the tenant's timezone. */
export function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Formats a plain calendar date (no time, no timezone shift), e.g. "08 Oct 2026". */
export function formatTaskDate(date: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${date}T00:00:00Z`));
}

/** Formats a timeline timestamp in the tenant's timezone, e.g. "05 Oct 2026, 9:31 am". */
export function formatActivityTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: timezone, day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

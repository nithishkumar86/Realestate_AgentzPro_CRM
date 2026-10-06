export interface AdAssignmentMember { userId: string; fullName: string; }

export interface AdAssignment {
  adId: string;
  adName: string | null;
  assigneeUserId: string | null;
  totalLeads: number;
  unassignedLeads: number;
}

export interface AdAssignmentOverview { ads: AdAssignment[]; members: AdAssignmentMember[]; }

/** Thrown for a 403: only the company owner manages ad assignment, and retrying can never succeed. */
export class AdAssignmentOwnerOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdAssignmentOwnerOnlyError";
  }
}

type ApiErrorPayload = { error?: { message?: string } };

async function failure(response: Response, fallback: string): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
  const message = payload?.error?.message ?? fallback;
  return response.status === 403 ? new AdAssignmentOwnerOnlyError(message) : new Error(message);
}

export async function getAdAssignments(signal?: AbortSignal): Promise<AdAssignmentOverview> {
  const response = await fetch("/api/settings/ad-assignments", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw await failure(response, "Ad assignments could not be loaded.");
  const payload = (await response.json().catch(() => null)) as AdAssignmentOverview | null;
  if (!payload || !Array.isArray(payload.ads) || !Array.isArray(payload.members)) {
    throw new Error("The ad assignments response was invalid.");
  }
  return payload;
}

/** Sets (or, with null, clears) who receives new leads from one ad. */
export async function setAdAssignee(adId: string, assigneeUserId: string | null): Promise<void> {
  const response = await fetch("/api/settings/ad-assignments/rule", {
    method: "PUT",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ adId, assigneeUserId }),
  });
  if (!response.ok) throw await failure(response, "The ad assignment could not be saved.");
}

/** Gives the ad's assignee every lead of that ad that is still unassigned. Returns how many changed. */
export async function applyAdAssignee(adId: string): Promise<number> {
  const response = await fetch("/api/settings/ad-assignments/apply", {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ adId }),
  });
  if (!response.ok) throw await failure(response, "The unassigned leads could not be assigned.");
  const payload = (await response.json().catch(() => null)) as { assigned?: unknown } | null;
  return typeof payload?.assigned === "number" ? payload.assigned : 0;
}

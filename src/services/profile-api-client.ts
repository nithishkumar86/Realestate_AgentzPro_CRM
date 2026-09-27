export interface ProfileDetails {
  fullName: string;
  phoneNumber: string;
  emailAddress: string;
  companyName: string;
  professionalRole: string;
}

type ApiErrorPayload = { error?: { message?: string } };

export async function getProfileDetails(signal?: AbortSignal): Promise<ProfileDetails> {
  const response = await fetch("/api/profile", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    const apiError = payload as ApiErrorPayload | null;
    throw new Error(apiError?.error?.message ?? "Your profile could not be loaded.");
  }

  if (!isProfileDetails(payload)) {
    throw new Error("The profile response was invalid.");
  }

  return payload;
}

function isProfileDetails(value: unknown): value is ProfileDetails {
  if (!value || typeof value !== "object") {
    return false;
  }

  const profile = value as Record<string, unknown>;
  return ["fullName", "phoneNumber", "emailAddress", "companyName", "professionalRole"]
    .every((key) => typeof profile[key] === "string" && profile[key].trim().length > 0);
}

export type EditableProfileField = "fullName" | "phoneNumber";

/** Saves the signed-in person's own name or 10-digit mobile number; returns the refreshed profile. */
export async function updateProfileDetails(
  changes: Partial<Record<EditableProfileField, string>>,
): Promise<ProfileDetails> {
  const response = await fetch("/api/profile", {
    method: "PATCH",
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(changes),
  });
  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    const apiError = payload as ApiErrorPayload | null;
    throw new Error(apiError?.error?.message ?? "Your profile could not be saved.");
  }

  if (!isProfileDetails(payload)) {
    throw new Error("The profile response was invalid.");
  }

  return payload;
}

import type { NextResponse } from "next/server";
import { AppError } from "@/lib/server/app-error";
import { verifySession } from "@/lib/server/auth/session";

/** These routes act on the signed-in person only; the user id is never read from the request. */
export async function requireSessionUserId(): Promise<string> {
  const session = await verifySession();
  if (!session) {
    throw new AppError("Authentication is required.", { status: 401, code: "UNAUTHENTICATED" });
  }
  return session.userId;
}

/** Responses here may set the active-company cookie, so no CDN or proxy may store them. */
export function withNoStore<T extends NextResponse>(response: T): T {
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

import { NextResponse } from "next/server";
import { isAppError } from "@/lib/server/app-error";
import { GoogleConnectionService } from "@/lib/server/google/google-connection-service";
import { GOOGLE_OAUTH_NONCE_COOKIE } from "@/lib/server/google/google-oauth";

export const runtime = "nodejs";

// Google redirects here after the consent screen. Always ends on the Connection page with a result flag,
// and always clears the one-time nonce cookie.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const cookieNonce = readCookie(request, GOOGLE_OAUTH_NONCE_COOKIE);
  let result = "connected";
  const googleError = url.searchParams.get("error");
  if (googleError) {
    result = googleError === "access_denied" ? "denied" : "failed";
  } else {
    try {
      await new GoogleConnectionService().completeConnect(url.searchParams.get("code"), url.searchParams.get("state"), cookieNonce);
    } catch (error) {
      result = isAppError(error) && error.code === "GOOGLE_ADS_SCOPE_MISSING" ? "scope_missing" : "failed";
      console.error(JSON.stringify({ operation: "google_connection", code: isAppError(error) ? error.code : "UNEXPECTED_ERROR" }));
    }
  }
  const response = NextResponse.redirect(new URL(`/connection?google=${result}`, url.origin));
  response.cookies.set(GOOGLE_OAUTH_NONCE_COOKIE, "", { path: "/api/integrations/google/callback", maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

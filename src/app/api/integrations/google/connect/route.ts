import { NextResponse } from "next/server";
import { createErrorResponse } from "@/app/api/meta/_lib/route-utils";
import { GoogleConnectionService } from "@/lib/server/google/google-connection-service";
import { GOOGLE_OAUTH_NONCE_COOKIE, GOOGLE_OAUTH_STATE_TTL_SECONDS } from "@/lib/server/google/google-oauth";

export const runtime = "nodejs";

// Owner clicks "Connect Google": send the browser to Google's consent screen. The nonce cookie is SameSite=Lax
// so it comes back on Google's top-level redirect to the callback, and only to the callback path.
export async function GET(request: Request) {
  try {
    const { authorizationUrl, nonce } = await new GoogleConnectionService().startConnect();
    const response = NextResponse.redirect(authorizationUrl);
    response.cookies.set(GOOGLE_OAUTH_NONCE_COOKIE, nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/integrations/google/callback",
      maxAge: GOOGLE_OAUTH_STATE_TTL_SECONDS,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

import { NextResponse } from "next/server";
import { isAppError } from "@/lib/server/app-error";
import { getCurrentProfileDetails } from "@/lib/server/profile-query-service";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    return privateNoStore(NextResponse.json(await getCurrentProfileDetails()));
  } catch (error) {
    const requestId = crypto.randomUUID();

    if (isAppError(error)) {
      console.error(JSON.stringify({ requestId, operation: "profile_read", code: error.code, status: error.status }));
      return privateNoStore(NextResponse.json(
        { error: { code: error.code, message: error.message, retryable: error.retryable }, requestId },
        { status: error.status },
      ));
    }

    console.error(JSON.stringify({ requestId, operation: "profile_read", code: "UNEXPECTED_ERROR", status: 500 }));
    return privateNoStore(NextResponse.json(
      { error: { code: "UNEXPECTED_ERROR", message: "Your profile could not be loaded.", retryable: false }, requestId },
      { status: 500 },
    ));
  }
}

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  response.headers.set("Vary", "Cookie");
  return response;
}

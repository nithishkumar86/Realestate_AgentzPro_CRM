import { NextResponse } from "next/server";
import { isAppError } from "@/lib/server/app-error";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { getCurrentProfileDetails } from "@/lib/server/profile-query-service";
import { updateCurrentProfile } from "@/lib/server/profile-update-service";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    return privateNoStore(NextResponse.json(await getCurrentProfileDetails()));
  } catch (error) {
    return errorResponse(error, "profile_read", "Your profile could not be loaded.");
  }
}

/** Edits the signed-in person's own name and/or phone number. Nothing else is editable. */
export async function PATCH(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = (await request.json().catch(() => null)) as unknown;
    return privateNoStore(NextResponse.json(await updateCurrentProfile(body)));
  } catch (error) {
    return errorResponse(error, "profile_update", "Your profile could not be saved.");
  }
}

function errorResponse(error: unknown, operation: string, fallbackMessage: string): NextResponse {
  const requestId = crypto.randomUUID();

  if (isAppError(error)) {
    console.error(JSON.stringify({ requestId, operation, code: error.code, status: error.status }));
    return privateNoStore(NextResponse.json(
      {
        error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details },
        requestId,
      },
      { status: error.status },
    ));
  }

  console.error(JSON.stringify({ requestId, operation, code: "UNEXPECTED_ERROR", status: 500 }));
  return privateNoStore(NextResponse.json(
    { error: { code: "UNEXPECTED_ERROR", message: fallbackMessage, retryable: false }, requestId },
    { status: 500 },
  ));
}

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  response.headers.set("Vary", "Cookie");
  return response;
}

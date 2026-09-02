import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AppError, isAppError } from "@/lib/server/app-error";

export async function parseJsonBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  try {
    return schema.parse(await request.json());
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      throw new AppError("Request data is invalid.", { status: 400, code: "INVALID_REQUEST" });
    }
    throw error;
  }
}

export function createErrorResponse(error: unknown): NextResponse {
  const requestId = crypto.randomUUID();
  if (isAppError(error)) {
    console.error(JSON.stringify({ requestId, operation: "meta_connection", code: error.code, status: error.status }));
    return NextResponse.json({ error: { code: error.code, message: error.message, retryable: error.retryable }, requestId }, { status: error.status });
  }
  console.error(JSON.stringify({ requestId, operation: "meta_connection", code: "UNEXPECTED_ERROR", status: 500 }));
  return NextResponse.json({ error: { code: "UNEXPECTED_ERROR", message: "The request could not be completed.", retryable: false }, requestId }, { status: 500 });
}

export function createSuccessResponse<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, { status });
}

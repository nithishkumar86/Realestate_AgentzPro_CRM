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

/**
 * Builds the client response and writes the one log line that has to be enough to diagnose the failure.
 *
 * The requestId is returned to the caller and logged, so a customer report ties to an exact log line.
 * What was missing is everything around it: an unexpected error logged only that id and the literal
 * string "UNEXPECTED_ERROR", so the single class of failure most in need of investigation — the one
 * nobody anticipated — left no message, no stack, and no route behind. Anything not an AppError is
 * therefore logged with its name, message, stack, and `cause` chain.
 *
 * The response body is unchanged: the client still sees only a generic message for unexpected errors.
 * Detail belongs in the log, not in an HTTP response.
 *
 * `request` is optional so existing callers keep working, but every route should pass it — the method and
 * path are what make a log line searchable.
 */
export function createErrorResponse(error: unknown, request?: Request): NextResponse {
  const requestId = crypto.randomUUID();
  const route = describeRoute(request);

  if (isAppError(error)) {
    console.error(JSON.stringify({
      requestId,
      operation: "meta_connection",
      ...route,
      code: error.code,
      status: error.status,
      retryable: error.retryable,
      message: error.message,
      // Only ever non-sensitive, machine-readable context by AppError's own contract.
      ...(error.details ? { details: error.details } : {}),
    }));
    return NextResponse.json(
      { error: { code: error.code, message: error.message, retryable: error.retryable, ...(error.details ? { details: error.details } : {}) }, requestId },
      { status: error.status },
    );
  }

  console.error(JSON.stringify({
    requestId,
    operation: "meta_connection",
    ...route,
    code: "UNEXPECTED_ERROR",
    status: 500,
    ...describeUnexpectedError(error),
  }));
  return NextResponse.json({ error: { code: "UNEXPECTED_ERROR", message: "The request could not be completed.", retryable: false }, requestId }, { status: 500 });
}

function describeRoute(request: Request | undefined): { method?: string; path?: string } {
  if (!request) {
    return {};
  }
  try {
    // Pathname only. Query strings on these routes are not expected to carry secrets, but logging whole
    // URLs is the habit that eventually logs one.
    return { method: request.method, path: new URL(request.url).pathname };
  } catch {
    return { method: request.method };
  }
}

function describeUnexpectedError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorName: typeof error, errorMessage: String(error) };
  }

  // The cause chain is followed because the actual fault is routinely two levels down — a driver error
  // wrapped by a client error wrapped by whatever finally threw. Bounded, so a self-referential cause
  // cannot spin here.
  const causes: string[] = [];
  let cause: unknown = error.cause;
  for (let depth = 0; cause instanceof Error && depth < 3; depth += 1) {
    causes.push(`${cause.name}: ${cause.message}`);
    cause = cause.cause;
  }

  return {
    errorName: error.name,
    errorMessage: error.message,
    stack: error.stack,
    ...(causes.length > 0 ? { causes } : {}),
  };
}

export function createSuccessResponse<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, { status });
}

export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly retryable: boolean;
  /**
   * Machine-readable, non-sensitive context for the client. Only ever set
   * deliberately at the throw site, and surfaced verbatim by
   * createErrorResponse — so it must never carry tokens, secrets, or
   * another tenant's data. Used to tell the browser which Facebook
   * permissions were declined (so it can re-request them) and which Page
   * lacks the tasks the leadgen subscription needs.
   */
  public readonly details?: Record<string, unknown>;

  public constructor(message: string, options: { status: number; code: string; retryable?: boolean; details?: Record<string, unknown> }) {
    super(message);
    this.name = "AppError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

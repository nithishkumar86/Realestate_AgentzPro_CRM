export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(message: string, options: { status: number; code: string; retryable?: boolean }) {
    super(message);
    this.name = "AppError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

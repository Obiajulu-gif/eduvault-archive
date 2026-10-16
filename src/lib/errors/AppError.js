import { ERROR_CODES, getErrorCode } from "./codes.js";

/**
 * Application error with a stable code, user-safe message, and correlation ID.
 *
 * Internal details (stack traces, raw driver errors) stay on the server; only
 * the user-safe message and recovery guidance cross the API boundary.
 */
export class AppError extends Error {
  constructor(code, { message, details = {}, cause } = {}) {
    const definition = getErrorCode(code);
    super(message || definition.userMessage);
    this.name = "AppError";
    this.code = definition.code;
    this.status = definition.status;
    this.retryable = definition.retryable;
    this.userMessage = definition.userMessage;
    this.recovery = definition.recovery;
    this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

export function isAppError(error) {
  return error instanceof AppError;
}

/**
 * Wraps any thrown value in an AppError with the given code, preserving the
 * original error as `cause` for server-side debugging.
 */
export function toAppError(error, code = "INTERNAL") {
  if (isAppError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppError(code, { message, cause: error });
}

export { ERROR_CODES };

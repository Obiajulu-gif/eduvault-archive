import { AppError, isAppError, toAppError } from "./AppError.js";
import { getErrorCode } from "./codes.js";

/**
 * Maps any thrown error to a user-safe representation.
 *
 * Known failure modes (AppError, ValidationError, MongoDB duplicate key,
 * network timeouts) map to stable codes with recovery guidance. Unknown
 * errors collapse to a generic INTERNAL code so internals never leak.
 */
export function toUserSafeError(error) {
  if (isAppError(error)) {
    return {
      code: error.code,
      status: error.status,
      retryable: error.retryable,
      userMessage: error.userMessage,
      recovery: error.recovery,
      details: error.details,
    };
  }

  // Field-level validation errors from src/lib/api/validation.js
  if (error?.name === "ValidationError") {
    const definition = getErrorCode("VALIDATION_FIELD");
    return {
      code: definition.code,
      status: definition.status,
      retryable: definition.retryable,
      userMessage: error.message || definition.userMessage,
      recovery: definition.recovery,
      details: error.details || {},
    };
  }

  // MongoDB duplicate key — a known conflict, not an internal fault
  if (error?.code === 11000) {
    const definition = getErrorCode("CONFLICT_DUPLICATE");
    return {
      code: definition.code,
      status: definition.status,
      retryable: definition.retryable,
      userMessage: definition.userMessage,
      recovery: definition.recovery,
      details: {},
    };
  }

  // Network / timeout failures are retryable
  if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT" || error?.name === "TimeoutError") {
    const definition = getErrorCode("SETTLEMENT_TIMEOUT");
    return {
      code: definition.code,
      status: definition.status,
      retryable: definition.retryable,
      userMessage: definition.userMessage,
      recovery: definition.recovery,
      details: {},
    };
  }

  const definition = getErrorCode("INTERNAL");
  return {
    code: definition.code,
    status: definition.status,
    retryable: definition.retryable,
    userMessage: definition.userMessage,
    recovery: definition.recovery,
    details: {},
  };
}

/**
 * Renders a user-safe error body (RFC 7807 Problem Details) with a correlation
 * ID support can use to find the matching server-side logs.
 */
export function renderUserSafeErrorBody(error, { correlationId, instance = "" } = {}) {
  const safe = toUserSafeError(error);
  return {
    type: `https://eduvault.dev/problems/${safe.code.toLowerCase()}`,
    title: safe.userMessage,
    status: safe.status,
    code: safe.code,
    detail: safe.recovery,
    retryable: safe.retryable,
    correlationId: correlationId || null,
    instance,
  };
}

export { AppError, toAppError };

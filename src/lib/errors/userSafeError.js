import { AppError, isAppError, toAppError } from "./AppError.js";
import { getErrorCode } from "./codes.js";

/**
 * Maps any thrown error to a user-safe representation.
 *
 * Known failure modes (AppError, ValidationError, MongoDB duplicate key,
 * network timeouts, session revocation, entitlement denial, blockchain errors)
 * map to stable codes with recovery guidance. Unknown errors collapse to a
 * generic INTERNAL code so internals never leak.
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

  // Session revocation / replay detection
  if (
    error?.code === "SESSION_REVOKED" ||
    error?.code === "TOKEN_REUSE_DETECTED" ||
    error?.message?.toLowerCase().includes("session revoked") ||
    error?.message?.toLowerCase().includes("replay")
  ) {
    const definition = getErrorCode("AUTH_TOKEN_REVOKED");
    return {
      code: definition.code,
      status: definition.status,
      retryable: definition.retryable,
      userMessage: definition.userMessage,
      recovery: definition.recovery,
      details: {},
    };
  }

  // Entitlement denial
  if (
    error?.code === "ENTITLEMENT_NOT_FOUND" ||
    error?.message?.toLowerCase().includes("entitlement") ||
    error?.message?.toLowerCase().includes("no access")
  ) {
    const definition = getErrorCode("ENTITLEMENT_NOT_FOUND");
    return {
      code: definition.code,
      status: definition.status,
      retryable: definition.retryable,
      userMessage: definition.userMessage,
      recovery: definition.recovery,
      details: {},
    };
  }

  // Stellar bad sequence number
  if (error?.message?.includes("tx_bad_seq") || error?.code === "tx_bad_seq") {
    const definition = getErrorCode("BLOCKCHAIN_BAD_SEQUENCE");
    return {
      code: definition.code,
      status: definition.status,
      retryable: definition.retryable,
      userMessage: definition.userMessage,
      recovery: definition.recovery,
      details: {},
    };
  }

  // Stellar missing trustline
  if (
    error?.message?.includes("op_no_trust") ||
    error?.message?.includes("op_no_destination") ||
    error?.code === "op_no_trust"
  ) {
    const definition = getErrorCode("BLOCKCHAIN_TRUSTLINE_MISSING");
    return {
      code: definition.code,
      status: definition.status,
      retryable: definition.retryable,
      userMessage: definition.userMessage,
      recovery: definition.recovery,
      details: {},
    };
  }

  // Checkout quote expired
  if (error?.message?.toLowerCase().includes("quote expired") || error?.code === "quote_expired") {
    const definition = getErrorCode("SETTLEMENT_QUOTE_EXPIRED");
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

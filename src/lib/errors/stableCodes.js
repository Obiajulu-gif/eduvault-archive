import { ERROR_CODES, getErrorCode } from "./codes.js";

/** Public, additive API error contract. Internal remediation hints stay private. */
export function publicError(code, overrides = {}) {
  const definition = getErrorCode(code);
  return {
    code: definition.code,
    status: definition.status,
    retryable: definition.retryable,
    message: definition.userMessage,
    recovery: definition.recovery,
    ...overrides
  };
}

export function publicErrorCatalog() {
  return Object.values(ERROR_CODES).map(({ code, status, retryable, userMessage, recovery }) => ({
    code,
    status,
    retryable,
    message: userMessage,
    recovery
  }));
}


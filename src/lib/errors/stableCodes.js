import { ERROR_CODES, getErrorCode, isKnownErrorCode } from "./codes.js";
import { hasPermission } from "../auth/permissions.js";

export class StableErrorAuthorizationError extends Error {
  constructor(message, { code = "AUTH_FORBIDDEN", status = 403 } = {}) {
    super(message);
    this.name = "StableErrorAuthorizationError";
    this.code = code;
    this.status = status;
    this.retryable = false;
  }
}

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

/**
 * Resolves any thrown error or error code into a safe, stable public error
 * payload without leaking raw internal error messages or remediation hints.
 */
export function resolveStableError(errorOrCode, { fallbackCode = "INTERNAL", correlationId = null } = {}) {
  const rawCode = typeof errorOrCode === "string" ? errorOrCode : errorOrCode?.code;
  const resolvedCode = isKnownErrorCode(rawCode) ? rawCode : fallbackCode;
  const base = publicError(resolvedCode);
  const retryable = typeof errorOrCode?.retryable === "boolean" ? errorOrCode.retryable : base.retryable;
  return {
    ...base,
    retryable,
    ...(correlationId ? { correlationId } : {}),
  };
}

/**
 * Returns internal operator/developer remediation hints for a registered code.
 * Enforces authentication and `operations:read` authorization so internal
 * triage details are never exposed to unprivileged callers.
 */
export async function getOperatorRemediation(code, { actor = null, authorize = null } = {}) {
  if (!actor) {
    throw new StableErrorAuthorizationError("Authentication required to view remediation hints.", {
      code: "AUTH_UNAUTHENTICATED",
      status: 401,
    });
  }
  const allowed = typeof authorize === "function"
    ? (await authorize(actor)) === true
    : hasPermission(actor, "operations:read");
  if (!allowed) {
    throw new StableErrorAuthorizationError("Insufficient permissions to view operator remediation hints.", {
      code: "AUTH_FORBIDDEN",
      status: 403,
    });
  }
  const definition = getErrorCode(code);
  return {
    code: definition.code,
    status: definition.status,
    retryable: definition.retryable,
    recovery: definition.recovery,
    remediationHints: [...(definition.remediationHints || [])],
    deprecated: Boolean(definition.deprecated),
    supersededBy: definition.supersededBy ?? null,
  };
}

/**
 * Validates that every registered error code satisfies the stability contract:
 * SCREAMING_SNAKE_CASE key/code, valid 4xx/5xx status, boolean retryable,
 * and non-empty userMessage, recovery, and remediationHints.
 */
export function validateStableErrorCatalog() {
  const violations = [];
  for (const [key, def] of Object.entries(ERROR_CODES)) {
    if (key !== def?.code || !/^[A-Z0-9_]+$/.test(key)) {
      violations.push(`${key}: code must match key in SCREAMING_SNAKE_CASE`);
    }
    if (typeof def?.status !== "number" || def.status < 200 || def.status > 599) {
      violations.push(`${key}: status must be a valid HTTP status (200-599)`);
    }
    if (typeof def?.retryable !== "boolean") {
      violations.push(`${key}: retryable must be a boolean`);
    }
    if (!def?.userMessage || !def?.recovery) {
      violations.push(`${key}: userMessage and recovery must be non-empty`);
    }
    if (!Array.isArray(def?.remediationHints) || def.remediationHints.length === 0) {
      violations.push(`${key}: remediationHints must be a non-empty array`);
    }
  }
  return { valid: violations.length === 0, count: Object.keys(ERROR_CODES).length, violations };
}


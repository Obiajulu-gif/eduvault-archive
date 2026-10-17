import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getErrorCode } from "../errors/codes.js";
import { getCorrelationId } from "../errors/correlation.js";

const STATUS_CODES = {
  400: "VALIDATION_FAILED",
  401: "AUTH_UNAUTHENTICATED",
  402: "SETTLEMENT_INSUFFICIENT_FUNDS",
  403: "AUTH_FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT_STATE",
  410: "MATERIAL_ARCHIVED",
  413: "VALIDATION_UPLOAD_TOO_LARGE",
  422: "VALIDATION_FIELD",
  429: "RATE_LIMITED",
  502: "SETTLEMENT_TX_FAILED",
  503: "SETTLEMENT_UNAVAILABLE",
  504: "SETTLEMENT_TIMEOUT",
  500: "INTERNAL",
};

/**
 * Backward-compatible RFC 9457 Problem Details response helper.
 * Existing callers may supply occurrence-specific detail; stable codes and
 * remediation hints always come from the shared taxonomy.
 */
export function errorResponse({
  status = 500,
  title,
  detail = "",
  instance = "",
  type = "about:blank",
  request,
  code,
} = {}) {
  const requestedDefinition = code ? getErrorCode(code) : null;
  const definition = requestedDefinition && requestedDefinition.code === code && requestedDefinition.status === status
    ? requestedDefinition
    : getErrorCode(STATUS_CODES[status] || "INTERNAL");
  const correlationId = request ? getCorrelationId(request) : crypto.randomUUID();
  const resolvedInstance = instance || (request ? new URL(request.url).pathname : "");
  const body = {
    type: type === "about:blank"
      ? `https://eduvault.dev/problems/${definition.code.toLowerCase()}`
      : type,
    title: title || definition.userMessage,
    status,
    detail: detail || definition.recovery,
    instance: resolvedInstance,
    code: definition.code,
    retryable: definition.retryable,
    recovery: definition.recovery,
    correlationId,
  };

  return NextResponse.json(body, {
    status,
    headers: {
      "Content-Type": "application/problem+json",
      "X-Correlation-Id": correlationId,
    },
  });
}

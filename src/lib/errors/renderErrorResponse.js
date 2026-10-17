import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { AppError } from "./AppError.js";
import { renderUserSafeErrorBody } from "./userSafeError.js";
import { getCorrelationId } from "./correlation.js";

/**
 * Builds an RFC 9457 `application/problem+json` response for any error.
 *
 * The body only ever contains user-safe fields (code, user message, recovery
 * guidance, correlation ID). Internal messages and stack traces stay in
 * server-side logs.
 */
export function renderErrorResponse(error, { request, correlationId, instance, retryAfter, legacyError } = {}) {
  const resolvedCorrelationId = correlationId || (request ? getCorrelationId(request) : crypto.randomUUID());
  const resolvedInstance = instance ?? (request ? new URL(request.url).pathname : "");
  const body = renderUserSafeErrorBody(error, {
    correlationId: resolvedCorrelationId,
    instance: resolvedInstance,
  });
  if (legacyError) body.error = legacyError;
  if (retryAfter !== undefined) body.retryAfter = retryAfter;
  const headers = { "Content-Type": "application/problem+json" };
  headers["X-Correlation-Id"] = resolvedCorrelationId;
  if (retryAfter !== undefined) headers["Retry-After"] = String(retryAfter);
  return NextResponse.json(body, { status: body.status, headers });
}

export function renderProblemResponse(code, request, legacyError) {
  return renderErrorResponse(new AppError(code), { request, legacyError });
}

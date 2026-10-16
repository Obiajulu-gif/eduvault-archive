import { NextResponse } from "next/server";
import { renderUserSafeErrorBody } from "./userSafeError.js";

/**
 * Builds an RFC 7807 `application/problem+json` response for any error.
 *
 * The body only ever contains user-safe fields (code, user message, recovery
 * guidance, correlation ID). Internal messages and stack traces stay in
 * server-side logs.
 */
export function renderErrorResponse(error, { correlationId, instance = "" } = {}) {
  const body = renderUserSafeErrorBody(error, { correlationId, instance });
  const headers = { "Content-Type": "application/problem+json" };
  if (correlationId) headers["X-Correlation-Id"] = correlationId;
  return NextResponse.json(body, { status: body.status, headers });
}

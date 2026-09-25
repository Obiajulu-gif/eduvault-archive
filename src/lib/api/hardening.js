import { NextResponse } from "next/server";
import { auditLog } from "./audit";
import { slidingWindowRateLimit } from "./rateLimit";
import { clientKey } from "./clientKey.mjs";
import { ValidationError } from "./validation";
import { captureException } from "@/lib/sentry";

export { clientKey } from "./clientKey.mjs";

export async function withApiHardening(request, options, handler) {
  const route = options.route;
  const method = request.method || "GET";
  const rateLimit = await slidingWindowRateLimit(`${route}:${method}:${clientKey(request)}`, options.rateLimit);

  if (!rateLimit.allowed) {
    auditLog({ event: "rate_limit_blocked", route, method, status: 429 });
    return NextResponse.json(
      { error: "Too many requests", retryAfter: rateLimit.retryAfter },
      { status: 429 }
    );
  }

  try {
    return await handler();
  } catch (error) {
    if (error instanceof ValidationError) {
      auditLog({ event: "validation_failed", route, method, status: 400, reason: error.message });
      return NextResponse.json({ error: error.message, details: error.details }, { status: 400 });
    }

    captureException(error, { route, method });
    throw error;
  }
}

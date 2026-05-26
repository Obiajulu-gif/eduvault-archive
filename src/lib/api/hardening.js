import { NextResponse } from "next/server";
import { auditLog } from "./audit";
import { checkRateLimit } from "./rateLimit";
import { ValidationError } from "./validation";
import { captureException } from "@/lib/sentry";

function clientKey(request) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}

export async function withApiHardening(request, options, handler) {
  const route = options.route;
  const method = request.method || "GET";
  const rateLimit = checkRateLimit(`${route}:${method}:${clientKey(request)}`, options.rateLimit);

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

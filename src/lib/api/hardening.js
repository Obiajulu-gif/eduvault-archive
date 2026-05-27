import { NextResponse } from "next/server";
import { auditLog } from "./audit";
import { checkRateLimit } from "./rateLimit";
import { ValidationError } from "./validation";
import { captureException } from "@/lib/sentry";
import { verifyDashboardToken } from "@/lib/auth/session";

const AUTHENTICATED_MULTIPLIER = parseInt(
  process.env.RATE_LIMIT_AUTH_MULTIPLIER || "3",
  10
);

function clientKey(request) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  return (
    forwardedFor?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local"
  );
}

async function getAuthTier(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookieMatch = cookieHeader.match(/auth_token=([^;]+)/);
  const token = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;

  if (!token) return "anonymous";

  const secret = process.env.JWT_SECRET;
  if (!secret) return "anonymous";

  try {
    const verification = await verifyDashboardToken(token, secret);
    return verification.valid ? "authenticated" : "anonymous";
  } catch {
    return "anonymous";
  }
}

export async function withApiHardening(request, options, handler) {
  const route = options.route;
  const method = request.method || "GET";

  // Determine auth tier for tiered rate limiting
  const authTier = await getAuthTier(request);

  // Resolve rate limit config with tiered multipliers
  const rateLimitOption = options.rateLimit || { limit: 60, windowMs: 60_000 };
  const effectiveRateLimit = { ...rateLimitOption };

  if (authTier === "authenticated") {
    effectiveRateLimit.limit = Math.floor(
      effectiveRateLimit.limit * AUTHENTICATED_MULTIPLIER
    );
  }

  // Use auth tier in key to maintain separate buckets per tier
  const rateLimitKey = `${route}:${method}:${clientKey(request)}:${authTier}`;
  const rateLimit = checkRateLimit(rateLimitKey, effectiveRateLimit);

  if (!rateLimit.allowed) {
    auditLog({
      event: "rate_limit_blocked",
      route,
      method,
      status: 429,
      authTier,
      clientKey: clientKey(request),
      retryAfter: rateLimit.retryAfter,
    });
    return NextResponse.json(
      { error: "Too many requests", retryAfter: rateLimit.retryAfter },
      { status: 429 }
    );
  }

  try {
    return await handler();
  } catch (error) {
    if (error instanceof ValidationError) {
      auditLog({
        event: "validation_failed",
        route,
        method,
        status: 400,
        reason: error.message,
      });
      return NextResponse.json(
        { error: error.message, details: error.details },
        { status: 400 }
      );
    }

    captureException(error, { route, method });
    throw error;
  }
}

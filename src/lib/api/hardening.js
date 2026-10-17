import { auditLog } from "./audit";
import { slidingWindowRateLimit } from "./rateLimit";
import { clientKey } from "./clientKey.mjs";
import { ValidationError } from "./validation";
import { captureException } from "@/lib/sentry";
import { AppError, isAppError } from "@/lib/errors/AppError.js";
import { renderErrorResponse } from "@/lib/errors/renderErrorResponse.js";

export { clientKey } from "./clientKey.mjs";

export async function withApiErrorHandling(request, options, handler) {
  const route = options.route;
  const method = request.method || "GET";
  try {
    return await handler();
  } catch (error) {
    if (error instanceof ValidationError) {
      auditLog({ event: "validation_failed", route, method, status: 400 });
      return renderErrorResponse(new AppError("VALIDATION_FIELD"), { request });
    }

    captureException(error, { route, method });
    return renderErrorResponse(
      isAppError(error)
        ? error
        : new AppError(options.errorCode || "INTERNAL", { cause: error }),
      { request }
    );
  }
}

export async function withApiHardening(request, options, handler) {
  const route = options.route;
  const method = request.method || "GET";
  const rateLimit = await slidingWindowRateLimit(`${route}:${method}:${clientKey(request)}`, options.rateLimit);

  if (!rateLimit.allowed) {
    auditLog({ event: "rate_limit_blocked", route, method, status: 429 });
    return renderErrorResponse(new AppError("RATE_LIMITED"), {
      request,
      retryAfter: rateLimit.retryAfter,
    });
  }

  return withApiErrorHandling(request, options, handler);
}

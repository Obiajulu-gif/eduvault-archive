import { NextResponse } from "next/server";
import { auditLog } from "./audit";
import { checkRateLimit } from "./rateLimit";
import { ValidationError } from "./validation";
import { captureException } from "@/lib/sentry";
import { runWithContext, currentTraceparent, currentCorrelationId } from "@/lib/telemetry/context";
import { withSpan } from "@/lib/telemetry/tracing";
import { incrementCounter, recordHistogram } from "@/lib/telemetry/metrics";
import { acquireSlot } from "@/lib/capacity/concurrency";
import { preRequestShed } from "@/lib/capacity/shed";
import { getRouteBudget } from "@/lib/capacity/budgets";
import { createDisconnectSignal } from "@/lib/capacity/backpressure";

function clientKey(request) {
  const forwardedFor = process.env.TRUST_PROXY === "true" ? request.headers.get("x-forwarded-for") : null;
  return forwardedFor?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}

export async function withApiHardening(request, options, handler) {
  const route = options.route;
  const method = request.method || "GET";
  const budget = getRouteBudget(method, route);

  return runWithContext(
    {
      correlationId: request.headers.get("x-correlation-id") || undefined,
      traceparent: request.headers.get("traceparent") || undefined,
      route,
    },
    async () => {
      // ── Load shedding check ────────────────────────────────────────
      const { shed, response: shedResponse } = preRequestShed(method, route);
      if (shed && shedResponse) {
        auditLog({ event: "load_shed", route, method, status: shedResponse.status });
        incrementCounter("http_requests_total", { route, method, outcome: "load_shed" });
        const res = NextResponse.json(shedResponse.body, {
          status: shedResponse.status,
          headers: { ...shedResponse.headers, "x-correlation-id": currentCorrelationId() },
        });
        return res;
      }

      // ── Payload size check ─────────────────────────────────────────
      if (budget.maxPayloadBytes > 0 && method !== "GET" && method !== "HEAD") {
        const contentLength = Number(request.headers.get("content-length") || 0);
        if (contentLength > budget.maxPayloadBytes) {
          const sizeMB = (contentLength / (1024 * 1024)).toFixed(2);
          const limitMB = (budget.maxPayloadBytes / (1024 * 1024)).toFixed(2);
          auditLog({ event: "payload_too_large", route, method, status: 413 });
          incrementCounter("http_requests_total", { route, method, outcome: "payload_too_large" });
          return NextResponse.json(
            { error: `Payload too large: ${sizeMB}MB exceeds limit of ${limitMB}MB` },
            { status: 413, headers: { "x-correlation-id": currentCorrelationId() } }
          );
        }
      }

      // ── Rate limiting ──────────────────────────────────────────────
      const dimensions = [
        clientKey(request),
        request.headers.get("x-account-id") || "anonymous",
        request.headers.get("x-wallet-address") || "no-wallet",
      ];
      const rateLimit = await checkRateLimit(
        `${route}:${method}:${dimensions.join(":")}`,
        { outagePolicy: options.rateLimit?.outagePolicy || (method === "GET" ? "open" : "closed"), ...options.rateLimit },
      );

      if (!rateLimit.allowed) {
        auditLog({ event: "rate_limit_blocked", route, method, status: 429 });
        incrementCounter("http_requests_total", { route, method, outcome: "rate_limited" });
        return NextResponse.json(
          { error: "Too many requests", retryAfter: rateLimit.retryAfter },
          {
            status: 429,
            headers: {
              "x-correlation-id": currentCorrelationId(),
              "RateLimit-Limit": String(rateLimit.limit),
              "RateLimit-Remaining": String(rateLimit.remaining),
              "Retry-After": String(rateLimit.retryAfter || 1),
            },
          }
        );
      }

      // ── Concurrency admission ──────────────────────────────────────
      const { acquired, release, overload } = await acquireSlot(method, route);

      if (!acquired && overload) {
        auditLog({ event: "concurrency_rejected", route, method, status: overload.status });
        incrementCounter("http_requests_total", { route, method, outcome: "concurrency_rejected" });
        const res = NextResponse.json(overload.body, {
          status: overload.status,
          headers: { ...overload.headers, "x-correlation-id": currentCorrelationId() },
        });
        return res;
      }

      // ── Client disconnect signal ───────────────────────────────────
      const { signal: disconnectSignal, cleanup: cleanupDisconnect } = createDisconnectSignal(request);

      const startedAt = Date.now();

      try {
        const response = await withSpan("http.request", { route, method }, async (span) => {
          const result = await handler({ disconnectSignal });
          span.setAttribute("http.status_code", result?.status || 200);
          return result;
        });

        recordHistogram("http_request_duration_ms", { route, method }, Date.now() - startedAt);
        incrementCounter("http_requests_total", { route, method, outcome: "success" });

        response.headers.set("x-correlation-id", currentCorrelationId());
        response.headers.set("traceparent", currentTraceparent());
        response.headers.set("x-capacity-inflight", "ok");
        return response;
      } catch (error) {
        recordHistogram("http_request_duration_ms", { route, method }, Date.now() - startedAt);

        if (error instanceof ValidationError) {
          auditLog({ event: "validation_failed", route, method, status: 400, reason: error.message });
          incrementCounter("http_requests_total", { route, method, outcome: "validation_error" });
          const res = NextResponse.json({ error: error.message, details: error.details }, { status: 400 });
          res.headers.set("x-correlation-id", currentCorrelationId());
          return res;
        }

        incrementCounter("http_requests_total", { route, method, outcome: "error" });
        captureException(error, { route, method, correlationId: currentCorrelationId() });
        throw error;
      } finally {
        release();
        cleanupDisconnect();
      }
    }
  );
}

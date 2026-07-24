/**
 * Route protection proxy — Next.js 16+ convention.
 *
 * Replaces the deprecated `src/middleware.js` convention.
 * Handles both rate limiting for API routes and auth protection
 * for dashboard routes.
 */
import { NextResponse } from "next/server";
import { isProtectedDashboardPath, verifyDashboardToken } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { slidingWindowRateLimit } from "@/lib/rateLimit";
import {
  applyBrowserSecurityHeaders,
  buildContentSecurityPolicy,
  createCspNonce,
} from "@/lib/security/csp";

/**
 * Per-route rate limit rules.
 */
const RATE_LIMIT_RULES = [
  {
    pattern: /^\/api\/(market-materials|subjects)(\/|$)/,
    limit: 100,
    windowMs: 60_000,
    label: "marketplace",
  },
  {
    pattern: /^\/api\/(upload|creator\/materials)(\/|$)/,
    limit: 5,
    windowMs: 60 * 60_000,
    label: "upload",
  },
  {
    pattern: /^\/api\/auth\//,
    limit: 20,
    windowMs: 60_000,
    label: "auth",
  },
];

function clientIp(request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anonymous"
  );
}

function applyRateLimiting(request) {
  const { pathname } = request.nextUrl;
  const ip = clientIp(request);

  for (const rule of RATE_LIMIT_RULES) {
    if (!rule.pattern.test(pathname)) continue;

    const result = slidingWindowRateLimit(`${rule.label}:${ip}`, {
      limit: rule.limit,
      windowMs: rule.windowMs,
    });

    const rateLimitHeaders = {
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(result.resetAt),
    };

    if (!result.allowed) {
      return new NextResponse(
        JSON.stringify({
          type: "about:blank",
          title: "Too Many Requests",
          status: 429,
          detail: `Rate limit exceeded. Please retry after ${result.retryAfter} seconds.`,
          instance: pathname,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/problem+json",
            "Retry-After": String(result.retryAfter),
            ...rateLimitHeaders,
          },
        }
      );
    }

    // Pass through with rate limit info headers
    const response = NextResponse.next();
    Object.entries(rateLimitHeaders).forEach(([k, v]) => response.headers.set(k, v));
    return response;
  }

  return null;
}

export async function proxy(req) {
  const nonce = createCspNonce();
  const csp = buildContentSecurityPolicy(nonce);
  const forwardedHeaders = new Headers(req.headers);
  forwardedHeaders.set("Content-Security-Policy", csp);
  forwardedHeaders.set("x-nonce", nonce);

  const next = () => NextResponse.next({ request: { headers: forwardedHeaders } });
  const secure = (response) => applyBrowserSecurityHeaders(response, { csp });

  // ── Rate limiting for API routes ────────────────────────────────────────
  const rateLimitResponse = applyRateLimiting(req);
  if (rateLimitResponse) return secure(rateLimitResponse);

  // ── Dashboard auth protection ───────────────────────────────────────────
  const token = req.cookies.get("auth_token")?.value;
  const { pathname } = req.nextUrl;

  logger.info({
    method: req.method,
    url: req.url,
    pathname,
    timestamp: new Date().toISOString()
  }, 'Incoming request');

  if (!isProtectedDashboardPath(pathname)) {
    return secure(next());
  }

  const authorized = token && process.env.JWT_SECRET &&
    (await verifyDashboardToken(token, process.env.JWT_SECRET)).valid;
  if (!authorized) {
    const url = new URL("/", req.url);
    return secure(NextResponse.redirect(url));
  }

  return secure(next());
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
    "/dashboard/:path*",
  ],
};

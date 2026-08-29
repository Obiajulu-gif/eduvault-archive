// Issue #649: strict, nonce-based CSP.
//
// next.config.mjs previously shipped `script-src 'self' 'unsafe-inline'
// 'unsafe-eval'` unconditionally — this defeats CSP's core XSS mitigation,
// since inline/eval'd script is allowed regardless of its origin. This
// middleware generates a fresh, cryptographically random nonce per request
// and builds the CSP here instead, so `next.config.mjs`'s static headers()
// no longer need to (and must not) also set script-src, or the two would
// conflict — only one Content-Security-Policy header can win, and Next
// merges middleware-set response headers on top of next.config's, so this
// is the actual effective policy.
//
// The nonce is threaded to the app via the `x-nonce` request header (read
// in src/app/layout.js via next/headers) and applied to the one inline
// <script> in this app (the theme-init snippet) via a `nonce` prop.

import { NextResponse } from 'next/server';

function generateNonce() {
  // 16 random bytes, base64-encoded — the standard nonce size used in
  // Next.js's own strict-CSP documentation/examples.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

export function middleware(request) {
  const nonce = generateNonce();

  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data: https: blob:",
    "font-src 'self' https: data:",
    "style-src 'self' 'unsafe-inline'", // Tailwind/inline styles still need this; scripts are the actual XSS vector this issue targets
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "connect-src 'self' https: wss:",
    "media-src 'self' https: blob:",
    "upgrade-insecure-requests",
    "report-uri /api/csp-report",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set('Content-Security-Policy', csp);

  return response;
}

export const config = {
  matcher: [
    // Apply to every route except static assets and Next internals, which
    // don't render the app shell / theme-init script and don't need a nonce.
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};

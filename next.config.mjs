import { assertRuntimeEnv } from "./src/lib/env.js";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactCompiler: true,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Content-Security-Policy is set in middleware.js instead of
          // here (issue #649): it needs a fresh per-request nonce, which a
          // static next.config header can't generate. Setting a CSP in
          // both places would mean the browser enforces BOTH policies
          // simultaneously (their intersection) — confusing to reason
          // about and unnecessary, so middleware is the single source of
          // truth for it.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default function config(phase) {
  // Fail fast on a broken environment at *every* non-CI entrypoint (#678):
  // development (`next dev`), the production server (`next start`), and the
  // production build itself. `assertRuntimeEnv` skips under CI so automated
  // builds can run without a full deployment .env, but a local production
  // build with placeholder contract IDs or webhook secrets must refuse to
  // proceed rather than ship a build that cannot serve traffic correctly.
  assertRuntimeEnv();

  return nextConfig;
}

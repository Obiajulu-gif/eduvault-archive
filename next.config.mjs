import { assertRuntimeEnv } from "./src/lib/env.js";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactCompiler: true,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
              "object-src 'none'",
              "img-src 'self' data: https: blob:",
              "font-src 'self' https: data:",
              "style-src 'self' 'unsafe-inline'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "connect-src 'self' https: wss:",
              "media-src 'self' https: blob:",
              "upgrade-insecure-requests",
            ].join("; "),
          },
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

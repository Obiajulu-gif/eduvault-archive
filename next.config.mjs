import { PHASE_PRODUCTION_BUILD } from "next/constants.js";
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
  if (phase !== PHASE_PRODUCTION_BUILD) {
    assertRuntimeEnv();
  }

  return nextConfig;
}

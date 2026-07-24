import { PHASE_PRODUCTION_BUILD } from "next/constants.js";
import { assertRuntimeEnv } from "./src/lib/env.js";

const imageHosts = ["gateway.pinata.cloud", "ipfs.io", "www.gravatar.com"];
try {
  const gateway = new URL(process.env.NEXT_PUBLIC_GATEWAY_URL);
  if (gateway.protocol === "https:") imageHosts.push(gateway.hostname);
} catch {}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactCompiler: true,
  serverExternalPackages: [],
  images: {
    remotePatterns: imageHosts.map((hostname) => ({ protocol: "https", hostname })),
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        "node:crypto": false,
        "node:async_hooks": false,
      };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
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

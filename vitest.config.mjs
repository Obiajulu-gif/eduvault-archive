import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const sentryMockPath = fileURLToPath(new URL("./test/mocks/sentry-nextjs.js", import.meta.url));
const otelMockPath = fileURLToPath(new URL("./test/mocks/opentelemetry-api.js", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": srcPath,
      "@sentry/nextjs": sentryMockPath,
      "@opentelemetry/api": otelMockPath,
    },
  },
  test: {
    environment: "jsdom",
    server: {
      deps: {
        inline: [],
      },
    },
    setupFiles: ["./test/setup-vitest.js"],
    include: [
      "src/**/*.{test,spec}.{js,jsx,ts,tsx}",
      "test/integration/**/*.{test,spec}.{js,jsx,ts,tsx}",
    ],
    exclude: ["tests/**", "archive/**", "contracts/**", "soroban/**", "node_modules/**"],
  },
});

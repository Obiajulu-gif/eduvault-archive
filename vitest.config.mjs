import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const sentryMockPath = fileURLToPath(new URL("./test/mocks/sentry-nextjs.js", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": srcPath,
      "@sentry/nextjs": sentryMockPath,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup-vitest.js"],
    include: [
      "src/**/*.{test,spec}.{js,jsx,ts,tsx}",
      "test/integration/**/*.{test,spec}.{js,jsx,ts,tsx}",
      "tests/components/**/*.{test,spec}.{js,jsx,ts,tsx}",
    ],
    // tests/backend runs under `node --test` and tests/legacy-evm under hardhat —
    // both use test runner globals incompatible with Vitest, so they stay excluded.
    exclude: ["tests/backend/**", "tests/legacy-evm/**", "archive/**", "contracts/**", "soroban/**", "node_modules/**"],
  },
});

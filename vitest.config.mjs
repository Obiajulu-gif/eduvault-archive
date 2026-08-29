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
    globalSetup: ["./test/global-setup-outbox.js"],
    include: [
      "src/**/*.{test,spec}.{js,jsx,ts,tsx}",
      "test/integration/**/*.{test,spec}.{js,jsx,ts,tsx}",
      "tests/components/**/*.{test,spec}.{js,jsx,ts,tsx}",
      // middleware.js (issue #649's nonce-based CSP) has to live at the repo
      // root for Next.js to recognize it as the app's middleware, so its
      // test does too.
      "middleware.test.js",
      // outbox.test.js uses vitest imports and mongodb-memory-server (real
      // Mongo query semantics matter here — see issue #635), unlike the rest
      // of tests/backend which runs under `node --test`. It was previously
      // caught by the blanket tests/backend/** exclude below and never
      // actually ran under any test command; explicitly included here so it
      // executes under `npm test`.
      "tests/backend/outbox.test.js",
    ],
    // The rest of tests/backend runs under `node --test` and tests/legacy-evm
    // under hardhat — both use test runner globals incompatible with Vitest,
    // so they stay excluded. Vitest's `exclude` wins over a matching
    // `include` entry, and its glob matcher doesn't support `!negation`, so
    // outbox.test.js is carved out via an extglob that matches every
    // tests/backend/*.mjs file but not the one *.js file.
    exclude: [
      "tests/backend/**/*.mjs",
      "tests/legacy-evm/**",
      "archive/**",
      "contracts/**",
      "soroban/**",
      "node_modules/**",
    ],
  },
});

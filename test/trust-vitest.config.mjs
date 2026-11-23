import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Trust routes use their own Mongo/session fakes; no outbox database is needed.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: [
      'src/app/api/materials/delete/route.trust.test.js',
      'src/app/api/verification/step-up/route.test.js',
    ],
  },
});

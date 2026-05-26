import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react-swc' // Added "plugin-" here
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    // Only run frontend/component tests through vitest.
    // Backend tests (tests/backend/*.mjs) use node:test and are run via
    // `npm run test:backend` (node --test). Legacy EVM tests run via hardhat.
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    exclude: [
      'tests/backend/**',
      'tests/legacy-evm/**',
      'node_modules/**',
    ],
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
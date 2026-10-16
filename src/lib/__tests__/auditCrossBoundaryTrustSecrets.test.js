import { describe, it, expect, afterEach, vi } from 'vitest';
import { auditCrossBoundaryTrustSecrets } from '../env';

// Executable check for the highest-risk finding in
// docs/threat-model-cross-boundary-trust.md: POST /api/webhooks/stellar
// fails open when neither STELLAR_WEBHOOK_SECRET nor CRON_SECRET is set in
// production, independent of whether outbound webhooks are configured.
// This is intentionally a separate test file from env.test.js so it can't
// collide with that file's pinned "does not require a webhook secret in
// production when webhooks are disabled" expectation for
// `validateRuntimeEnv` -- the two functions make deliberately different
// tradeoffs for the same underlying secret.
const REAL_ENV = process.env;

afterEach(() => {
  process.env = { ...REAL_ENV };
  vi.restoreAllMocks();
});

describe('auditCrossBoundaryTrustSecrets', () => {
  it('warns in production when neither STELLAR_WEBHOOK_SECRET nor CRON_SECRET is set', () => {
    process.env = {
      ...REAL_ENV,
      NODE_ENV: 'production',
      STELLAR_WEBHOOK_SECRET: '',
      CRON_SECRET: '',
      WEBHOOK_URL: '',
    };

    const warnings = auditCrossBoundaryTrustSecrets();
    expect(warnings.some((w) => w.includes('/api/webhooks/stellar'))).toBe(true);
  });

  it('does not warn in production once STELLAR_WEBHOOK_SECRET is set', () => {
    process.env = {
      ...REAL_ENV,
      NODE_ENV: 'production',
      STELLAR_WEBHOOK_SECRET: 'a-long-webhook-secret-0123456789abcdef',
      CRON_SECRET: '',
    };

    expect(auditCrossBoundaryTrustSecrets()).toEqual([]);
  });

  it('does not warn in production once CRON_SECRET alone is set', () => {
    process.env = {
      ...REAL_ENV,
      NODE_ENV: 'production',
      STELLAR_WEBHOOK_SECRET: '',
      CRON_SECRET: 'a-long-cron-secret-0123456789abcdef',
    };

    expect(auditCrossBoundaryTrustSecrets()).toEqual([]);
  });

  it('never warns outside production, even with no secret set', () => {
    process.env = {
      ...REAL_ENV,
      NODE_ENV: 'development',
      STELLAR_WEBHOOK_SECRET: '',
      CRON_SECRET: '',
    };

    expect(auditCrossBoundaryTrustSecrets()).toEqual([]);
  });

  it('treats a placeholder secret the same as an unset one', () => {
    process.env = {
      ...REAL_ENV,
      NODE_ENV: 'production',
      STELLAR_WEBHOOK_SECRET: 'YOUR_STELLAR_WEBHOOK_SECRET',
      CRON_SECRET: '',
    };

    const warnings = auditCrossBoundaryTrustSecrets();
    expect(warnings.length).toBe(1);
  });
});

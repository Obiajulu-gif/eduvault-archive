import { describe, it, expect, afterEach, vi } from 'vitest';
import { validateRuntimeEnv, assertRuntimeEnv } from '../env';

const REAL_ENV = process.env;

afterEach(() => {
  process.env = { ...REAL_ENV };
  vi.restoreAllMocks();
});

const GOOD_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADWKM';

function cleanEnv(overrides = {}) {
  process.env = {
    NODE_ENV: 'production',
    CI: 'true',
    NEXT_PUBLIC_APP_URL: 'https://eduvault.example.com',
    MONGODB_URI: 'mongodb://prod.example.com/eduvault',
    JWT_SECRET: 'a-very-long-secret-that-exceeds-the-minimum-length',
    PINATA_JWT: 'a-real-pinata-jwt',
    NEXT_PUBLIC_GATEWAY_URL: 'https://gateway.pinata.cloud',
    NEXT_PUBLIC_STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    NEXT_PUBLIC_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID: GOOD_CONTRACT_ID,
    NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID: GOOD_CONTRACT_ID,
    STELLAR_WEBHOOK_SECRET: 'a-long-webhook-secret-0123456789abcdef',
    WEBHOOK_URL: 'https://hooks.example.com/webhook',
    ...overrides,
  };
}

describe('validateRuntimeEnv (#678) — contract IDs', () => {
  it('accepts a valid production environment', () => {
    cleanEnv();
    expect(validateRuntimeEnv()).toEqual([]);
  });

  it('flags a missing material registry contract ID when the RPC is configured', () => {
    cleanEnv({ NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID: '' });
    const errors = validateRuntimeEnv();
    expect(errors.some((e) => e.includes('NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID'))).toBe(true);
  });

  it('flags a malformed contract ID (not a C-prefixed 56-char address)', () => {
    cleanEnv({ NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID: 'not-a-contract' });
    const errors = validateRuntimeEnv();
    expect(errors.some((e) => e.includes('is not a valid Soroban contract ID'))).toBe(true);
  });

  it('flags a placeholder contract ID', () => {
    cleanEnv({
      NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID: 'YOUR_PURCHASE_MANAGER_CONTRACT_ID',
    });
    const errors = validateRuntimeEnv();
    expect(errors.some((e) => e.includes('NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID'))).toBe(true);
  });

  it('flags an asset contract ID that is really an EVM-style 0x address', () => {
    cleanEnv({
      NEXT_PUBLIC_SOROBAN_CONTRACT_ID: '0x3f48520ca0d8d51345b416b5a3e083dac8790f55',
    });
    const errors = validateRuntimeEnv();
    expect(errors.some((e) => e.includes('NEXT_PUBLIC_SOROBAN_CONTRACT_ID'))).toBe(true);
  });
});

describe('validateRuntimeEnv (#678) — webhook secrets', () => {
  it('flags a missing webhook secret in production when webhooks are enabled', () => {
    cleanEnv({ STELLAR_WEBHOOK_SECRET: '', CRON_SECRET: '' });
    const errors = validateRuntimeEnv();
    expect(
      errors.some((e) => e.includes('STELLAR_WEBHOOK_SECRET (or CRON_SECRET)'))
    ).toBe(true);
  });

  it('flags a placeholder webhook secret in production', () => {
    cleanEnv({ STELLAR_WEBHOOK_SECRET: 'YOUR_STELLAR_WEBHOOK_SECRET' });
    const errors = validateRuntimeEnv();
    expect(
      errors.some((e) => e.includes('STELLAR_WEBHOOK_SECRET (or CRON_SECRET)'))
    ).toBe(true);
  });

  it('flags a short webhook secret in production', () => {
    cleanEnv({ STELLAR_WEBHOOK_SECRET: 'short' });
    const errors = validateRuntimeEnv();
    expect(errors.some((e) => e.includes('at least 32 characters'))).toBe(true);
  });

  it('does not require a webhook secret in production when webhooks are disabled', () => {
    cleanEnv({
      STELLAR_WEBHOOK_SECRET: '',
      CRON_SECRET: '',
      WEBHOOK_URL: '',
    });
    const errors = validateRuntimeEnv();
    expect(
      errors.some((e) => e.includes('STELLAR_WEBHOOK_SECRET (or CRON_SECRET)'))
    ).toBe(false);
  });
});

describe('validateRuntimeEnv (#678) — placeholders outside test/dev', () => {
  it('flags a placeholder JWT_SECRET in production', () => {
    cleanEnv({ JWT_SECRET: 'replace-with-a-long-random-string' });
    const errors = validateRuntimeEnv();
    expect(errors.some((e) => e.includes('JWT_SECRET'))).toBe(true);
  });

  it('flags a production MONGODB_URI pointing at localhost', () => {
    cleanEnv({ MONGODB_URI: 'mongodb://localhost:27017/eduvault' });
    const errors = validateRuntimeEnv();
    expect(errors.some((e) => e.includes('MONGODB_URI'))).toBe(true);
  });
});

describe('assertRuntimeEnv (#678)', () => {
  it('throws with all errors for an invalid environment outside CI', () => {
    cleanEnv({
      CI: 'false',
      NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID: '',
      STELLAR_WEBHOOK_SECRET: '',
      CRON_SECRET: '',
      WEBHOOK_URL: 'https://hooks.example.com',
    });
    expect(() => assertRuntimeEnv()).toThrow('Invalid deployment environment');
  });

  it('skips validation under CI', () => {
    cleanEnv({ CI: 'true', NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID: '' });
    expect(() => assertRuntimeEnv()).not.toThrow();
  });
});

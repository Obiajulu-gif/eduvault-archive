import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { validateRuntimeEnv, assertRuntimeEnv } from '../../src/lib/env.js';

describe('Environment Configuration Validation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: 'production' };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('fails fast when required configuration is missing in production', () => {
    process.env.NEXT_PUBLIC_APP_URL = ''; // Placeholder
    process.env.MONGODB_URI = 'replace-me';
    process.env.JWT_SECRET = '';
    
    const errors = validateRuntimeEnv();
    assert.ok(errors.some(e => e.includes('NEXT_PUBLIC_APP_URL is missing')));
    assert.ok(errors.some(e => e.includes('MONGODB_URI is missing')));
    assert.ok(errors.some(e => e.includes('JWT_SECRET is missing')));
  });

  it('fails fast when malformed Soroban contract ID is provided', () => {
    process.env.NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID = 'CINVALID123';
    
    const errors = validateRuntimeEnv();
    assert.ok(errors.some(e => e.includes('NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID is not a valid Soroban contract ID')));
  });

  it('fails fast when accidentally using production-like secrets in local mode', () => {
    process.env.NODE_ENV = 'development';
    process.env.MONGODB_URI = 'mongodb+srv://user:pass@cluster.mongodb.net/test';
    process.env.PINATA_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI...';
    
    const errors = validateRuntimeEnv();
    assert.ok(errors.some(e => e.includes('Local mode should not use a production MongoDB URI')));
    assert.ok(errors.some(e => e.includes('Local mode is using a real Pinata JWT')));
  });

  it('secrets are never printed in full in validation errors', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'short'; // Length < 32
    process.env.CRON_SECRET = 'short2';
    process.env.WEBHOOK_URL = 'http://test';
    
    const errors = validateRuntimeEnv();
    const jwtError = errors.find(e => e.includes('JWT_SECRET must be at least 32 characters long'));
    assert.ok(jwtError);
    assert.ok(!jwtError.includes('short')); // The secret shouldn't be in the error message
  });

  it('passes when valid local configuration is provided', () => {
    process.env.NODE_ENV = 'development';
    process.env.MONGODB_URI = 'mongodb://localhost:27017/eduvault';
    process.env.JWT_SECRET = 'a-real-random-string-that-is-not-a-placeholder';
    process.env.PINATA_JWT = 'not-a-real-jwt-but-valid-length';
    process.env.NEXT_PUBLIC_GATEWAY_URL = 'http://localhost:8080/ipfs/';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    process.env.NEXT_PUBLIC_STELLAR_RPC_URL = '';
    process.env.NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID = '';
    
    const errors = validateRuntimeEnv();
    assert.deepEqual(errors, []); // No errors in dev mode for placeholders
  });
  
  it('assertRuntimeEnv throws an error when environment is invalid', () => {
    process.env.NODE_ENV = 'production';
    process.env.CI = 'false';
    process.env.MONGODB_URI = 'replace-me';
    
    assert.throws(() => assertRuntimeEnv(), /Invalid deployment environment/);
  });
});

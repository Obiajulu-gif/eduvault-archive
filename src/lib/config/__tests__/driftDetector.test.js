import { describe, it, expect, beforeEach } from 'vitest';
import { CONFIG_CONTRACT } from '../configContract.js';
import {
  detectDrift,
  formatDriftReport,
  redactValue,
  isSecretKey,
  isAllowedDifference,
  SECRET_KEYS,
  ALLOWED_DIFFERENCES,
  ALL_KNOWN_KEYS,
  CORE_COMPARABLE_KEYS,
  parseEnvFile,
} from '../driftDetector.js';

const secret = (label) => `${label}-`.padEnd(48, 'x');
const contractId = (letter) => `C${letter.repeat(55)}`;
const seed = `S${'A'.repeat(55)}`;

function productionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    NEXT_PUBLIC_APP_URL: 'https://eduvault.example',
    MONGODB_URI: 'mongodb+srv://app@cluster0.example.mongodb.net/eduvault',
    JWT_SECRET: secret('jwt'),
    PINATA_JWT: secret('pinata'),
    NEXT_PUBLIC_GATEWAY_URL: 'https://gateway.pinata.cloud',
    NEXT_PUBLIC_STELLAR_NETWORK: 'PUBLIC',
    NEXT_PUBLIC_STELLAR_RPC_URL: 'https://soroban-mainnet.stellar.org',
    NEXT_PUBLIC_HORIZON_URL: 'https://horizon.stellar.org',
    NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID: contractId('A'),
    NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID: contractId('B'),
    STELLAR_WEBHOOK_SECRET: secret('webhook'),
    UNSUBSCRIBE_TOKEN_SECRET: secret('unsubscribe'),
    DOWNLOAD_CAPABILITY_SECRET: secret('download'),
    EDUVAULT_SANDBOX: 'false',
    ...overrides,
  };
}

function stagingEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    NEXT_PUBLIC_APP_URL: 'https://staging.eduvault.example',
    MONGODB_URI: 'mongodb+srv://app@cluster0-staging.example.mongodb.net/eduvault',
    JWT_SECRET: secret('jwt-staging'),
    PINATA_JWT: secret('pinata-staging'),
    NEXT_PUBLIC_GATEWAY_URL: 'https://gateway.pinata.cloud',
    NEXT_PUBLIC_STELLAR_NETWORK: 'TESTNET',
    NEXT_PUBLIC_STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    NEXT_PUBLIC_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID: contractId('C'),
    NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID: contractId('D'),
    STELLAR_WEBHOOK_SECRET: secret('webhook-staging'),
    UNSUBSCRIBE_TOKEN_SECRET: secret('unsubscribe-staging'),
    DOWNLOAD_CAPABILITY_SECRET: secret('download-staging'),
    EDUVAULT_SANDBOX: 'false',
    ...overrides,
  };
}

function developmentEnv(overrides = {}) {
  return {
    NODE_ENV: 'development',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    MONGODB_URI: 'mongodb://localhost:27017/eduvault',
    JWT_SECRET: 'dev-jwt-secret-local-only',
    PINATA_JWT: 'dev-pinata-jwt-local-only',
    NEXT_PUBLIC_GATEWAY_URL: 'https://gateway.pinata.cloud',
    NEXT_PUBLIC_STELLAR_NETWORK: 'TESTNET',
    NEXT_PUBLIC_STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    NEXT_PUBLIC_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    EDUVAULT_SANDBOX: 'true',
    ...overrides,
  };
}

describe('Configuration Drift Detector (#875)', () => {
  describe('redactValue', () => {
    it('redacts secret keys by showing only first 4 and last 4 chars', () => {
      const result = redactValue('JWT_SECRET', 'abcdefghijklmnopqrstuvwxyz123456789012');
      expect(result).toBe('abcd****9012');
    });

    it('redacts short secrets as ****', () => {
      const result = redactValue('JWT_SECRET', 'short');
      expect(result).toBe('****');
    });

    it('does not redact non-secret keys', () => {
      const result = redactValue('NEXT_PUBLIC_APP_URL', 'https://example.com');
      expect(result).toBe('https://example.com');
    });

    it('truncates very long non-secret values', () => {
      const longValue = 'a'.repeat(250);
      const result = redactValue('SOME_KEY', longValue);
      // 200 chars + '...[truncated]' (13 chars) = 213
      expect(result.length).toBeLessThanOrEqual(215);
      expect(result).toContain('[truncated]');
    });

    it('handles undefined/null values', () => {
      expect(redactValue('JWT_SECRET', undefined)).toBeUndefined();
      expect(redactValue('JWT_SECRET', null)).toBeNull();
    });
  });

  describe('isSecretKey', () => {
    it('identifies known secret keys', () => {
      expect(isSecretKey('JWT_SECRET')).toBe(true);
      expect(isSecretKey('PINATA_JWT')).toBe(true);
      expect(isSecretKey('STELLAR_ADMIN_SECRET')).toBe(true);
      expect(isSecretKey('UNSUBSCRIBE_TOKEN_SECRET')).toBe(true);
    });

    it('returns false for non-secret keys', () => {
      expect(isSecretKey('NEXT_PUBLIC_APP_URL')).toBe(false);
      expect(isSecretKey('MONGODB_URI')).toBe(false);
      expect(isSecretKey('NEXT_PUBLIC_STELLAR_NETWORK')).toBe(false);
    });
  });

  describe('isAllowedDifference', () => {
    it('allows network differences between TESTNET and PUBLIC', () => {
      const result = isAllowedDifference('NEXT_PUBLIC_STELLAR_NETWORK', 'TESTNET', 'PUBLIC', 'staging', 'production');
      expect(result.allowed).toBe(true);
      expect(result.rule).toBe('network');
    });

    it('allows contract ID differences', () => {
      const result = isAllowedDifference(
        'NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID',
        contractId('A'),
        contractId('B'),
        'staging',
        'production'
      );
      expect(result.allowed).toBe(true);
      expect(result.rule).toBe('contract-id');
    });

    it('allows app URL differences', () => {
      const result = isAllowedDifference(
        'NEXT_PUBLIC_APP_URL',
        'https://staging.example.com',
        'https://production.example.com',
        'staging',
        'production'
      );
      expect(result.allowed).toBe(true);
      expect(result.rule).toBe('app-url');
    });

    it('allows database URI differences', () => {
      const result = isAllowedDifference(
        'MONGODB_URI',
        'mongodb://localhost:27017/db',
        'mongodb+srv://cluster.example.net/db',
        'development',
        'production'
      );
      expect(result.allowed).toBe(true);
      expect(result.rule).toBe('database-uri');
    });

    it('allows sandbox flag differences', () => {
      const result = isAllowedDifference('EDUVAULT_SANDBOX', 'true', 'false', 'development', 'production');
      expect(result.allowed).toBe(true);
      expect(result.rule).toBe('sandbox-flag');
    });

    it('allows feature flag differences', () => {
      const result = isAllowedDifference(
        'FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS',
        'true',
        'false',
        'staging',
        'production'
      );
      expect(result.allowed).toBe(true);
      expect(result.rule).toBe('feature-flag');
    });

    it('allows secret differences (secrets are environment-specific)', () => {
      const result = isAllowedDifference('JWT_SECRET', 'secret1', 'secret2', 'staging', 'production');
      expect(result.allowed).toBe(true);
      expect(result.rule).toBe('secret-per-environment');
    });

    it('rejects invalid contract IDs', () => {
      const result = isAllowedDifference(
        'NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID',
        'INVALID',
        contractId('B'),
        'staging',
        'production'
      );
      expect(result.allowed).toBe(false);
    });

    it('rejects secret differences when one is empty', () => {
      const result = isAllowedDifference('JWT_SECRET', 'secret1', '', 'staging', 'production');
      expect(result.allowed).toBe(false);
    });
  });

  describe('detectDrift - matching configurations', () => {
    it('reports no drift when configurations are identical', () => {
      const env = productionEnv();
      const report = detectDrift(env, env, 'prod1', 'prod2');

      expect(report.summary.matching).toBeGreaterThan(0);
      expect(report.summary.missingInA).toBe(0);
      expect(report.summary.missingInB).toBe(0);
      expect(report.summary.mismatched).toBe(0);
      expect(report.summary.hasCriticalDrift).toBe(false);
      expect(report.summary.hasHighDrift).toBe(false);
    });

    it('reports matching for all shared keys', () => {
      const env = productionEnv();
      const report = detectDrift(env, env, 'prod1', 'prod2');

      expect(report.matching.length).toBeGreaterThan(0);
      for (const match of report.matching) {
        expect(match.value).toBeDefined();
      }
    });
  });

  describe('detectDrift - missing keys', () => {
    it('detects keys missing in environment A', () => {
      const envA = productionEnv({ JWT_SECRET: '' });
      const envB = productionEnv();
      const report = detectDrift(envA, envB, 'prodA', 'prodB');

      const missing = report.missingInA.find(m => m.key === 'JWT_SECRET');
      expect(missing).toBeDefined();
      expect(missing.severity).toBe('high'); // JWT_SECRET is a secret key
    });

    it('detects keys missing in environment B', () => {
      const envA = productionEnv();
      const envB = productionEnv({ PINATA_JWT: '' });
      const report = detectDrift(envA, envB, 'prodA', 'prodB');

      const missing = report.missingInB.find(m => m.key === 'PINATA_JWT');
      expect(missing).toBeDefined();
      expect(missing.severity).toBe('high');
    });

    it('reports missing non-secret keys with medium severity', () => {
      const envA = productionEnv({ NEXT_PUBLIC_APP_URL: '' });
      const envB = productionEnv();
      const report = detectDrift(envA, envB, 'prodA', 'prodB');

      const missing = report.missingInA.find(m => m.key === 'NEXT_PUBLIC_APP_URL');
      expect(missing).toBeDefined();
      expect(missing.severity).toBe('medium');
    });

    it('ignores keys missing in both environments', () => {
      const envA = productionEnv({ WEBHOOK_URL: '' });
      const envB = productionEnv({ WEBHOOK_URL: '' });
      const report = detectDrift(envA, envB, 'prodA', 'prodB');

      const missingInA = report.missingInA.find(m => m.key === 'WEBHOOK_URL');
      const missingInB = report.missingInB.find(m => m.key === 'WEBHOOK_URL');
      expect(missingInA).toBeUndefined();
      expect(missingInB).toBeUndefined();
    });
  });

  describe('detectDrift - mismatched values (unexpected drift)', () => {
    it('classifies different secret values as allowed differences (not mismatches)', () => {
      const envA = productionEnv({ JWT_SECRET: secret('jwt-a') });
      const envB = productionEnv({ JWT_SECRET: secret('jwt-b') });
      const report = detectDrift(envA, envB, 'prodA', 'prodB');

      // Secrets are expected to differ per environment
      const allowed = report.allowedDifferences.find(m => m.key === 'JWT_SECRET');
      expect(allowed).toBeDefined();
      expect(allowed.rule).toBe('secret-per-environment');
      // Should NOT be in mismatched
      const mismatch = report.mismatched.find(m => m.key === 'JWT_SECRET');
      expect(mismatch).toBeUndefined();
    });

    it('detects mismatched non-secret values as high when not allowed', () => {
      // Use a key that's not in ALLOWED_DIFFERENCES
      const envA = { CUSTOM_NON_SECRET: 'value-a' };
      const envB = { CUSTOM_NON_SECRET: 'value-b' };
      const report = detectDrift(envA, envB, 'envA', 'envB', { keysToCompare: ['CUSTOM_NON_SECRET'] });

      const mismatch = report.mismatched.find(m => m.key === 'CUSTOM_NON_SECRET');
      expect(mismatch).toBeDefined();
      expect(mismatch.severity).toBe('high');
    });

    it('detects mismatched tuning parameters as allowed', () => {
      const envA = productionEnv({ STELLAR_SURGE_FEE_THRESHOLD: '500' });
      const envB = productionEnv({ STELLAR_SURGE_FEE_THRESHOLD: '1000' });
      const report = detectDrift(envA, envB, 'prodA', 'prodB');

      // STELLAR_SURGE_FEE_THRESHOLD is an allowed difference (tuning-parameter)
      const allowed = report.allowedDifferences.find(a => a.key === 'STELLAR_SURGE_FEE_THRESHOLD');
      expect(allowed).toBeDefined();
    });

    it('detects unexpected mismatch for unknown keys', () => {
      const envA = { CUSTOM_KEY: 'value-a' };
      const envB = { CUSTOM_KEY: 'value-b' };
      const report = detectDrift(envA, envB, 'envA', 'envB', { keysToCompare: ['CUSTOM_KEY'] });

      const mismatch = report.mismatched.find(m => m.key === 'CUSTOM_KEY');
      expect(mismatch).toBeDefined();
      expect(mismatch.severity).toBe('high');
    });
  });

  describe('detectDrift - allowed differences', () => {
    it('classifies network differences as allowed', () => {
      const envA = stagingEnv();
      const envB = productionEnv();
      const report = detectDrift(envA, envB, 'staging', 'production');

      const allowed = report.allowedDifferences.filter(a =>
        ['NEXT_PUBLIC_STELLAR_NETWORK', 'NEXT_PUBLIC_STELLAR_RPC_URL', 'NEXT_PUBLIC_HORIZON_URL'].includes(a.key)
      );
      expect(allowed.length).toBe(3);
      for (const a of allowed) {
        expect(a.rule).toBeDefined();
        expect(a.description).toBeDefined();
      }
    });

    it('classifies contract ID differences as allowed', () => {
      const envA = stagingEnv();
      const envB = productionEnv();
      const report = detectDrift(envA, envB, 'staging', 'production');

      const allowed = report.allowedDifferences.filter(a =>
        ['NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID', 'NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID'].includes(a.key)
      );
      expect(allowed.length).toBe(2);
    });

    it('classifies app URL differences as allowed', () => {
      const envA = stagingEnv();
      const envB = productionEnv();
      const report = detectDrift(envA, envB, 'staging', 'production');

      const allowed = report.allowedDifferences.find(a => a.key === 'NEXT_PUBLIC_APP_URL');
      expect(allowed).toBeDefined();
      expect(allowed.rule).toBe('app-url');
    });

    it('classifies database URI differences as allowed', () => {
      const envA = stagingEnv();
      const envB = productionEnv();
      const report = detectDrift(envA, envB, 'staging', 'production');

      const allowed = report.allowedDifferences.find(a => a.key === 'MONGODB_URI');
      expect(allowed).toBeDefined();
      expect(allowed.rule).toBe('database-uri');
    });

    it('classifies sandbox flag differences as allowed when both present', () => {
      const envA = developmentEnv();
      const envB = productionEnv({ EDUVAULT_SANDBOX: 'false' });
      const report = detectDrift(envA, envB, 'development', 'production');

      const allowed = report.allowedDifferences.find(a => a.key === 'EDUVAULT_SANDBOX');
      expect(allowed).toBeDefined();
      expect(allowed.rule).toBe('sandbox-flag');
    });

    it('classifies secret differences as allowed', () => {
      const envA = stagingEnv();
      const envB = productionEnv();
      const report = detectDrift(envA, envB, 'staging', 'production');

      const secretKeys = ['JWT_SECRET', 'PINATA_JWT', 'STELLAR_WEBHOOK_SECRET', 'DOWNLOAD_CAPABILITY_SECRET', 'UNSUBSCRIBE_TOKEN_SECRET'];
      for (const key of secretKeys) {
        const allowed = report.allowedDifferences.find(a => a.key === key);
        expect(allowed).toBeDefined();
        expect(allowed.rule).toBe('secret-per-environment');
      }
    });

    it('classifies feature flag differences as allowed', () => {
      const envA = stagingEnv({ FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS: 'true' });
      const envB = productionEnv({ FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS: 'false' });
      const report = detectDrift(envA, envB, 'staging', 'production');

      const allowed = report.allowedDifferences.find(a => a.key === 'FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS');
      expect(allowed).toBeDefined();
      expect(allowed.rule).toBe('feature-flag');
    });
  });

  describe('detectDrift - secret redaction in output', () => {
    it('redacts secrets in allowed differences output by default', () => {
      const envA = productionEnv({ JWT_SECRET: secret('jwt-a') });
      const envB = productionEnv({ JWT_SECRET: secret('jwt-b') });
      const report = detectDrift(envA, envB, 'prodA', 'prodB', { redactSecrets: true });

      const allowed = report.allowedDifferences.find(m => m.key === 'JWT_SECRET');
      expect(allowed).toBeDefined();
      // Values should be redacted
      expect(allowed.prodA).toContain('****');
      expect(allowed.prodB).toContain('****');
      // Original values should not appear
      expect(allowed.prodA).not.toContain(secret('jwt-a'));
      expect(allowed.prodB).not.toContain(secret('jwt-b'));
    });

    it('redacts secrets in missing key output', () => {
      const envA = productionEnv({ JWT_SECRET: '' });
      const envB = productionEnv({ JWT_SECRET: secret('jwt-b') });
      const report = detectDrift(envA, envB, 'prodA', 'prodB', { redactSecrets: true });

      const missing = report.missingInA.find(m => m.key === 'JWT_SECRET');
      expect(missing).toBeDefined();
      expect(missing.prodB).toContain('****');
      expect(missing.prodB).not.toContain(secret('jwt-b'));
    });

    it('redacts secrets in matching keys output', () => {
      const envA = productionEnv({ JWT_SECRET: secret('shared') });
      const envB = productionEnv({ JWT_SECRET: secret('shared') });
      const report = detectDrift(envA, envB, 'prodA', 'prodB', { redactSecrets: true });

      const match = report.matching.find(m => m.key === 'JWT_SECRET');
      expect(match).toBeDefined();
      expect(match.value).toContain('****');
      expect(match.value).not.toContain(secret('shared'));
    });

    it('shows full values when redactSecrets is false', () => {
      const envA = productionEnv({ JWT_SECRET: secret('jwt-a') });
      const envB = productionEnv({ JWT_SECRET: secret('jwt-b') });
      const report = detectDrift(envA, envB, 'prodA', 'prodB', { redactSecrets: false });

      const allowed = report.allowedDifferences.find(m => m.key === 'JWT_SECRET');
      expect(allowed).toBeDefined();
      expect(allowed.prodA).toBe(secret('jwt-a'));
      expect(allowed.prodB).toBe(secret('jwt-b'));
    });

    it('never includes secret values in formatted report', () => {
      const envA = productionEnv({ JWT_SECRET: 'tiny-secret', PINATA_JWT: 'replace-me' });
      const envB = productionEnv({ JWT_SECRET: 'other-secret', PINATA_JWT: 'replace-me' });
      const report = detectDrift(envA, envB, 'prodA', 'prodB');
      const formatted = formatDriftReport(report);

      expect(formatted).not.toContain('tiny-secret');
      expect(formatted).not.toContain('other-secret');
    });
  });

  describe('detectDrift - cross-environment scenarios', () => {
    it('detects drift between staging and production', () => {
      const staging = stagingEnv();
      const production = productionEnv();
      const report = detectDrift(staging, production, 'staging', 'production');

      // Should have allowed differences for network, contracts, URLs, secrets
      expect(report.summary.allowedDifferences).toBeGreaterThan(0);
      // Should have no unexpected drift
      expect(report.summary.mismatched).toBe(0);
      expect(report.summary.hasCriticalDrift).toBe(false);
      expect(report.summary.hasHighDrift).toBe(false);
    });

    it('detects drift between development and production', () => {
      const dev = developmentEnv();
      const prod = productionEnv();
      const report = detectDrift(dev, prod, 'development', 'production');

      expect(report.summary.allowedDifferences).toBeGreaterThan(0);
      expect(report.summary.missingInA).toBeGreaterThan(0); // Dev missing production-only keys
      expect(report.summary.mismatched).toBe(0); // No unexpected mismatches
    });

    it('detects when production has a key staging is missing', () => {
      const staging = stagingEnv({ UNSUBSCRIBE_TOKEN_SECRET: '' }); // Required in production only
      const production = productionEnv();
      const report = detectDrift(staging, production, 'staging', 'production');

      const missing = report.missingInA.find(m => m.key === 'UNSUBSCRIBE_TOKEN_SECRET');
      expect(missing).toBeDefined();
      expect(missing.severity).toBe('high');
    });
  });

  describe('formatDriftReport', () => {
    it('formats a human-readable report', () => {
      const envA = productionEnv({ JWT_SECRET: secret('a') });
      const envB = productionEnv({ JWT_SECRET: secret('b') });
      const report = detectDrift(envA, envB, 'A', 'B');
      const formatted = formatDriftReport(report);

      expect(formatted).toContain('Configuration Drift Report');
      expect(formatted).toContain('A ↔ B');
      expect(formatted).toContain('Allowed differences');
      expect(formatted).toContain('JWT_SECRET');
    });

    it('includes summary counts', () => {
      const envA = productionEnv();
      const envB = productionEnv({ NEXT_PUBLIC_APP_URL: 'https://other.example.com' });
      const report = detectDrift(envA, envB, 'A', 'B');
      const formatted = formatDriftReport(report);

      expect(formatted).toContain('Summary:');
      expect(formatted).toContain('Matching:');
    });

    it('shows allowed differences section', () => {
      const staging = stagingEnv();
      const prod = productionEnv();
      const report = detectDrift(staging, prod, 'staging', 'production');
      const formatted = formatDriftReport(report);

      expect(formatted).toContain('Allowed differences');
    });

    it('shows overall status - no unexpected drift', () => {
      const envA = productionEnv();
      const envB = productionEnv();
      const report = detectDrift(envA, envB, 'A', 'B');
      const formatted = formatDriftReport(report);

      expect(formatted).toContain('NO UNEXPECTED DRIFT');
    });

    it('shows drift detected warning when there are mismatches', () => {
      const envA = { CUSTOM_KEY: 'value-a' };
      const envB = { CUSTOM_KEY: 'value-b' };
      const report = detectDrift(envA, envB, 'A', 'B', { keysToCompare: ['CUSTOM_KEY'] });
      const formatted = formatDriftReport(report);

      expect(formatted).toContain('DRIFT DETECTED');
    });
  });

  describe('parseEnvFile', () => {
    it('parses simple key=value pairs', () => {
      const content = 'KEY1=value1\nKEY2=value2\n';
      const result = parseEnvFile(content);
      expect(result.KEY1).toBe('value1');
      expect(result.KEY2).toBe('value2');
    });

    it('handles export prefix', () => {
      const content = 'export KEY=value\n';
      const result = parseEnvFile(content);
      expect(result.KEY).toBe('value');
    });

    it('strips surrounding quotes', () => {
      const content = 'KEY="value"\nKEY2=\'value2\'\n';
      const result = parseEnvFile(content);
      expect(result.KEY).toBe('value');
      expect(result.KEY2).toBe('value2');
    });

    it('ignores comments and empty lines', () => {
      const content = '# comment\n\nKEY=value\n  \n';
      const result = parseEnvFile(content);
      expect(result.KEY).toBe('value');
      expect(Object.keys(result).length).toBe(1);
    });

    it('handles values with equals signs', () => {
      const content = 'KEY=value=with=equals\n';
      const result = parseEnvFile(content);
      expect(result.KEY).toBe('value=with=equals');
    });
  });

  describe('SECRET_KEYS coverage', () => {
    it('includes all secrets from CONFIG_CONTRACT', () => {
      const secretKinds = ['secret', 'stellarSeed'];
      const contractSecrets = CORE_COMPARABLE_KEYS.filter(
        name => CONFIG_CONTRACT.find(s => s.name === name && secretKinds.includes(s.kind))
      );
      for (const key of contractSecrets) {
        expect(SECRET_KEYS.has(key)).toBe(true);
      }
    });
  });

  describe('ALLOWED_DIFFERENCES coverage', () => {
    it('has a rule for each network-specific key', () => {
      const networkKeys = ['NEXT_PUBLIC_STELLAR_NETWORK', 'NEXT_PUBLIC_STELLAR_RPC_URL', 'NEXT_PUBLIC_HORIZON_URL', 'NEXT_PUBLIC_EXPLORER_URL'];
      for (const key of networkKeys) {
        const rule = ALLOWED_DIFFERENCES.find(d => d.keys.includes(key));
        expect(rule).toBeDefined();
      }
    });

    it('has a rule for each contract ID key', () => {
      const contractKeys = ['NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID', 'NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID', 'NEXT_PUBLIC_SOROBAN_CONTRACT_ID'];
      for (const key of contractKeys) {
        const rule = ALLOWED_DIFFERENCES.find(d => d.keys.includes(key));
        expect(rule).toBeDefined();
      }
    });

    it('has a rule for sandbox flag', () => {
      const rule = ALLOWED_DIFFERENCES.find(d => d.keys.includes('EDUVAULT_SANDBOX'));
      expect(rule).toBeDefined();
      expect(rule.rule).toBe('sandbox-flag');
    });

    it('has a rule for secret keys', () => {
      const rule = ALLOWED_DIFFERENCES.find(d => d.keys.includes('JWT_SECRET'));
      expect(rule).toBeDefined();
      expect(rule.rule).toBe('secret-per-environment');
    });
  });

  describe('unsafe output prevention', () => {
    it('never leaks secret values in any report field', () => {
      const secretValue = 'super-secret-value-that-should-never-appear';
      const envA = { JWT_SECRET: secretValue, OTHER_KEY: 'value' };
      const envB = { JWT_SECRET: 'different-secret', OTHER_KEY: 'value' };
      const report = detectDrift(envA, envB, 'A', 'B');

      // Check all output fields
      const allOutput = JSON.stringify(report);
      expect(allOutput).not.toContain(secretValue);
    });

    it('never leaks Stellar secret seeds in output', () => {
      const envA = { STELLAR_ADMIN_SECRET: seed };
      const envB = { STELLAR_ADMIN_SECRET: 'S' + 'B'.repeat(55) };
      const report = detectDrift(envA, envB, 'A', 'B');

      const allOutput = JSON.stringify(report);
      expect(allOutput).not.toContain(seed);
    });

    it('never leaks JWT tokens in output', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const envA = { JWT_SECRET: jwt };
      const envB = { JWT_SECRET: 'different' };
      const report = detectDrift(envA, envB, 'A', 'B');

      const allOutput = JSON.stringify(report);
      expect(allOutput).not.toContain(jwt);
    });

    it('redacts secrets in matching keys too', () => {
      const envA = { JWT_SECRET: secret('shared') };
      const envB = { JWT_SECRET: secret('shared') };
      const report = detectDrift(envA, envB, 'A', 'B');

      const match = report.matching.find(m => m.key === 'JWT_SECRET');
      expect(match).toBeDefined();
      expect(match.value).toContain('****');
      expect(match.value).not.toContain(secret('shared'));
    });
  });

  describe('edge cases', () => {
    it('handles empty string as missing', () => {
      const envA = { KEY: '' };
      const envB = { KEY: 'value' };
      const report = detectDrift(envA, envB, 'A', 'B', { keysToCompare: ['KEY'] });

      expect(report.missingInA.length).toBe(1);
      expect(report.missingInA[0].key).toBe('KEY');
    });

    it('handles whitespace-only as missing', () => {
      const envA = { KEY: '   ' };
      const envB = { KEY: 'value' };
      const report = detectDrift(envA, envB, 'A', 'B', { keysToCompare: ['KEY'] });

      expect(report.missingInA.length).toBe(1);
    });

    it('handles keys with only one environment provided', () => {
      const envA = { KEY_A: 'value' };
      const envB = { KEY_B: 'value' };
      const report = detectDrift(envA, envB, 'A', 'B', { keysToCompare: ['KEY_A', 'KEY_B'] });

      expect(report.missingInA.find(m => m.key === 'KEY_B')).toBeDefined();
      expect(report.missingInB.find(m => m.key === 'KEY_A')).toBeDefined();
    });

    it('includes timestamp in report', () => {
      const envA = productionEnv();
      const envB = productionEnv();
      const report = detectDrift(envA, envB, 'A', 'B');

      expect(report.timestamp).toBeDefined();
      expect(new Date(report.timestamp).toString()).not.toBe('Invalid Date');
    });
  });
});
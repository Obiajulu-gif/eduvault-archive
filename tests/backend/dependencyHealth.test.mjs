import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEPENDENCY_STATUS,
  REQUIRED_DEPENDENCIES,
  sanitizeDiagnostics,
  checkDatabaseDependency,
  checkStorageDependency,
  checkStellarDependency,
  checkEmailDependency,
  checkContractsDependency,
  checkAllDependencies,
  formatMaintainerReport,
} from '../../src/lib/health/dependencyChecker.js';

test('sanitizeDiagnostics strictly redacts secrets, tokens, and credentials', () => {
  const payload = {
    mongoUri: 'mongodb://admin:superSecretPassword123@cluster.mongodb.net:27017/eduvault',
    jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature',
    stellarSecret: 'SB2A6Z6G5G6H7J8K9L0M1N2O3P4Q5R6S7T8U9V0W1X2Y3Z4A5B6C7D8E',
    evmKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    nested: {
      password: 'mypassword',
      apiToken: 'secret_token_123',
      normalField: 'hello-world',
    },
  };

  const sanitized = sanitizeDiagnostics(payload);

  assert.equal(sanitized.mongoUri.includes('superSecretPassword123'), false);
  assert.equal(sanitized.mongoUri.includes('[REDACTED_CREDENTIALS]'), true);
  assert.equal(sanitized.jwt, '[REDACTED_JWT]');
  assert.equal(sanitized.stellarSecret, '[REDACTED_STELLAR_SECRET]');
  assert.equal(sanitized.evmKey, '[REDACTED_EVM_PRIVATE_KEY]');
  assert.equal(sanitized.nested.password, '[REDACTED]');
  assert.equal(sanitized.nested.apiToken, '[REDACTED]');
  assert.equal(sanitized.nested.normalField, 'hello-world');
});

test('checkDatabaseDependency handles healthy, degraded, unavailable, and misconfigured states', async () => {
  // 1. Misconfigured - missing MONGODB_URI
  const misconfiguredMissing = await checkDatabaseDependency({ env: { MONGODB_URI: '' } });
  assert.equal(misconfiguredMissing.status, DEPENDENCY_STATUS.MISCONFIGURED);
  assert.ok(misconfiguredMissing.remediation);

  // 2. Misconfigured - invalid protocol format
  const misconfiguredProtocol = await checkDatabaseDependency({ env: { MONGODB_URI: 'http://localhost:27017' } });
  assert.equal(misconfiguredProtocol.status, DEPENDENCY_STATUS.MISCONFIGURED);
  assert.ok(misconfiguredProtocol.remediation);

  // 3. Healthy - ping succeeds
  const mockDbHealthy = {
    command: async () => ({ ok: 1 }),
  };
  const healthy = await checkDatabaseDependency({
    env: { MONGODB_URI: 'mongodb://localhost:27017/eduvault' },
    db: mockDbHealthy,
  });
  assert.equal(healthy.status, DEPENDENCY_STATUS.HEALTHY);
  assert.equal(healthy.remediation, null);

  // 4. Degraded - ping is slow (> 1500ms)
  const mockDbSlow = {
    command: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1550));
      return { ok: 1 };
    },
  };
  const degraded = await checkDatabaseDependency({
    env: { MONGODB_URI: 'mongodb://localhost:27017/eduvault' },
    db: mockDbSlow,
  });
  assert.equal(degraded.status, DEPENDENCY_STATUS.DEGRADED);
  assert.ok(degraded.remediation);

  // 5. Unavailable - ping throws connection error
  const mockDbFailing = {
    command: async () => {
      throw new Error('Connection refused at mongodb://user:pass@127.0.0.1:27017');
    },
  };
  const unavailable = await checkDatabaseDependency({
    env: { MONGODB_URI: 'mongodb://localhost:27017/eduvault' },
    db: mockDbFailing,
  });
  assert.equal(unavailable.status, DEPENDENCY_STATUS.UNAVAILABLE);
  assert.ok(unavailable.remediation);
  assert.equal(unavailable.message.includes('pass'), false); // zero-secret check
});

test('checkStorageDependency handles healthy, degraded, unavailable, and misconfigured states', async () => {
  // 1. Misconfigured - missing PINATA_JWT
  const misconfigured = await checkStorageDependency({ env: { PINATA_JWT: '' } });
  assert.equal(misconfigured.status, DEPENDENCY_STATUS.MISCONFIGURED);
  assert.ok(misconfigured.remediation);

  // 2. Healthy - testAuthentication succeeds with custom gateway
  const mockPinataHealthy = {
    testAuthentication: async () => ({ status: 200 }),
  };
  const healthy = await checkStorageDependency({
    env: {
      PINATA_JWT: 'valid-jwt',
      NEXT_PUBLIC_GATEWAY_URL: 'https://dedicated.mypinata.cloud',
    },
    pinataClient: mockPinataHealthy,
  });
  assert.equal(healthy.status, DEPENDENCY_STATUS.HEALTHY);
  assert.equal(healthy.remediation, null);

  // 3. Degraded - custom gateway not configured (fallback public gateway)
  const degraded = await checkStorageDependency({
    env: {
      PINATA_JWT: 'valid-jwt',
      NEXT_PUBLIC_GATEWAY_URL: 'https://gateway.pinata.cloud',
    },
    pinataClient: mockPinataHealthy,
  });
  assert.equal(degraded.status, DEPENDENCY_STATUS.DEGRADED);
  assert.ok(degraded.remediation);

  // 4. Unavailable - authentication fails
  const mockPinataFailing = {
    testAuthentication: async () => {
      throw new Error('Unauthorized: Invalid JWT token');
    },
  };
  const unavailable = await checkStorageDependency({
    env: {
      PINATA_JWT: 'bad-jwt',
      NEXT_PUBLIC_GATEWAY_URL: 'https://dedicated.mypinata.cloud',
    },
    pinataClient: mockPinataFailing,
  });
  assert.equal(unavailable.status, DEPENDENCY_STATUS.UNAVAILABLE);
  assert.ok(unavailable.remediation);
});

test('checkStellarDependency handles healthy, degraded, unavailable, and misconfigured states', async () => {
  // 1. Misconfigured - invalid URL
  const misconfigured = await checkStellarDependency({
    env: {
      NEXT_PUBLIC_STELLAR_RPC_URL: 'not-a-url',
      NEXT_PUBLIC_HORIZON_URL: 'https://horizon.stellar.org',
    },
  });
  assert.equal(misconfigured.status, DEPENDENCY_STATUS.MISCONFIGURED);
  assert.ok(misconfigured.remediation);

  // 2. Healthy - Horizon root and RPC getHealth return healthy
  const mockHorizon = { root: async () => ({ horizon_version: '2.0' }) };
  const mockRpcHealthy = { getHealth: async () => ({ status: 'healthy' }) };
  const healthy = await checkStellarDependency({
    env: {
      NEXT_PUBLIC_STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
      NEXT_PUBLIC_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    },
    horizonServer: mockHorizon,
    rpcServer: mockRpcHealthy,
  });
  assert.equal(healthy.status, DEPENDENCY_STATUS.HEALTHY);
  assert.equal(healthy.remediation, null);

  // 3. Degraded - Soroban RPC syncing / degraded
  const mockRpcDegraded = { getHealth: async () => ({ status: 'syncing' }) };
  const degraded = await checkStellarDependency({
    env: {
      NEXT_PUBLIC_STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
      NEXT_PUBLIC_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    },
    horizonServer: mockHorizon,
    rpcServer: mockRpcDegraded,
  });
  assert.equal(degraded.status, DEPENDENCY_STATUS.DEGRADED);
  assert.ok(degraded.remediation);

  // 4. Unavailable - Horizon throws network error
  const mockHorizonDown = {
    root: async () => {
      throw new Error('ENOTFOUND horizon-testnet.stellar.org');
    },
  };
  const unavailable = await checkStellarDependency({
    env: {
      NEXT_PUBLIC_STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
      NEXT_PUBLIC_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    },
    horizonServer: mockHorizonDown,
    rpcServer: mockRpcHealthy,
  });
  assert.equal(unavailable.status, DEPENDENCY_STATUS.UNAVAILABLE);
  assert.ok(unavailable.remediation);
});

test('checkEmailDependency handles healthy, degraded, unavailable, and misconfigured states', async () => {
  // 1. Degraded in development when no credentials are configured
  const degradedDev = await checkEmailDependency({
    env: { NODE_ENV: 'development' },
  });
  assert.equal(degradedDev.status, DEPENDENCY_STATUS.DEGRADED);
  assert.ok(degradedDev.remediation);

  // 2. Misconfigured in production when credentials are missing
  const misconfiguredProd = await checkEmailDependency({
    env: { NODE_ENV: 'production' },
  });
  assert.equal(misconfiguredProd.status, DEPENDENCY_STATUS.MISCONFIGURED);
  assert.ok(misconfiguredProd.remediation);

  // 3. Misconfigured when partial credentials provided
  const misconfiguredPartial = await checkEmailDependency({
    env: { SMTP_USER: 'user@example.com' },
  });
  assert.equal(misconfiguredPartial.status, DEPENDENCY_STATUS.MISCONFIGURED);
  assert.ok(misconfiguredPartial.remediation);

  // 4. Healthy when verification succeeds
  const mockVerifier = async () => true;
  const healthy = await checkEmailDependency({
    env: {
      SMTP_HOST: 'smtp.mailgun.org',
      SMTP_PORT: '587',
      SMTP_USER: 'postmaster@example.com',
      SMTP_PASS: 'secretpass',
    },
    emailVerifier: mockVerifier,
  });
  assert.equal(healthy.status, DEPENDENCY_STATUS.HEALTHY);
  assert.equal(healthy.remediation, null);

  // 5. Unavailable when verification throws
  const mockVerifierFailing = async () => {
    throw new Error('535 Authentication credentials invalid');
  };
  const unavailable = await checkEmailDependency({
    env: {
      SMTP_HOST: 'smtp.mailgun.org',
      SMTP_PORT: '587',
      SMTP_USER: 'postmaster@example.com',
      SMTP_PASS: 'secretpass',
    },
    emailVerifier: mockVerifierFailing,
  });
  assert.equal(unavailable.status, DEPENDENCY_STATUS.UNAVAILABLE);
  assert.ok(unavailable.remediation);
});

test('checkContractsDependency handles healthy, degraded, unavailable, and misconfigured states', async () => {
  const validContractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  // 1. Healthy - valid contract ID configured
  const healthy = await checkContractsDependency({
    env: {
      NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID: validContractId,
    },
  });
  assert.equal(healthy.status, DEPENDENCY_STATUS.HEALTHY);

  // 2. Misconfigured - invalid format
  const misconfigured = await checkContractsDependency({
    env: {
      NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID: 'invalid-address',
    },
  });
  assert.equal(misconfigured.status, DEPENDENCY_STATUS.MISCONFIGURED);
  assert.ok(misconfigured.remediation);

  // 3. Degraded in development when no contracts are configured
  const degradedDev = await checkContractsDependency({
    env: { NODE_ENV: 'development' },
  });
  assert.equal(degradedDev.status, DEPENDENCY_STATUS.DEGRADED);

  // 4. Unavailable in production when no contracts are configured
  const unavailableProd = await checkContractsDependency({
    env: { NODE_ENV: 'production' },
  });
  assert.equal(unavailableProd.status, DEPENDENCY_STATUS.UNAVAILABLE);
  assert.ok(unavailableProd.remediation);
});

test('checkAllDependencies and formatMaintainerReport aggregate results safely', async () => {
  const validContractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const mockDb = { command: async () => ({ ok: 1 }) };
  const mockPinata = { testAuthentication: async () => ({ status: 200 }) };
  const mockHorizon = { root: async () => ({ horizon_version: '2.0' }) };
  const mockRpc = { getHealth: async () => ({ status: 'healthy' }) };
  const mockEmail = async () => true;

  const env = {
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://localhost:27017/eduvault',
    PINATA_JWT: 'valid-token',
    NEXT_PUBLIC_GATEWAY_URL: 'https://dedicated.pinata.cloud',
    NEXT_PUBLIC_STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    NEXT_PUBLIC_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'user',
    SMTP_PASS: 'password',
    NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID: validContractId,
  };

  const report = await checkAllDependencies({
    env,
    db: mockDb,
    pinataClient: mockPinata,
    horizonServer: mockHorizon,
    rpcServer: mockRpc,
    emailVerifier: mockEmail,
  });

  assert.equal(report.status, DEPENDENCY_STATUS.HEALTHY);
  assert.equal(report.summary.total, 5);
  assert.equal(report.summary.healthy, 5);
  assert.equal(report.remediations.length, 0);

  const formatted = formatMaintainerReport(report);
  assert.ok(formatted.includes('EDUVAULT DEPENDENCY HEALTH & DIAGNOSTICS'));
  assert.ok(formatted.includes('OVERALL STATUS : HEALTHY'));
  assert.equal(formatted.includes('password'), false); // ensures zero secrets leaked
});

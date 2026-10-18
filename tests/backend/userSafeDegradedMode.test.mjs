import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeWithUserSafeDegradation,
  sanitizeForUser,
  validateAuthBoundary,
  setDependencyHealth,
  getDependencyHealth,
  resetDependencyRegistry,
  getDegradedModeEvents,
  DEPENDENCY_STATE,
} from '../../src/lib/degradation/userSafeDegradedMode.js';

describe('User-Safe Degraded Mode (#988)', () => {
  beforeEach(() => {
    resetDependencyRegistry();
  });

  describe('Sanitization and Zero-Leakage Invariant', () => {
    it('redacts MongoDB connection strings, internal IPs, and credentials', () => {
      const raw = 'Failed to connect to mongodb+srv://admin:s3cr3t_pass@cluster.internal:27017/eduvault?ssl=true at 10.0.4.12';
      const sanitized = sanitizeForUser(raw);
      assert.equal(sanitized.includes('admin:s3cr3t_pass'), false);
      assert.equal(sanitized.includes('cluster.internal'), false);
      assert.equal(sanitized.includes('10.0.4.12'), false);
      assert.equal(sanitized.includes('mongodb+srv'), false);
    });

    it('redacts Stellar secret keys and Pinata API keys', () => {
      const raw = 'Transaction failed using seed SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and pinata_api_key=secret_123';
      const sanitized = sanitizeForUser(raw);
      assert.equal(sanitized.includes('SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false);
      assert.equal(sanitized.includes('secret_123'), false);
    });

    it('strips stack traces from error messages', () => {
      const error = new Error('Service timeout\n    at Object.<anonymous> (/var/task/node_modules/stellar-sdk/lib.js:45:12)\n    at processTicksAndRejections');
      const sanitized = sanitizeForUser(error);
      assert.equal(sanitized.includes('/var/task/node_modules'), false);
      assert.equal(sanitized.includes('at Object.<anonymous>'), false);
    });
  });

  describe('Authorization Boundary Invariant', () => {
    it('rejects unauthenticated requests before checking dependency or fallback', async () => {
      let actionCalled = false;
      let fallbackCalled = false;

      await assert.rejects(
        async () => {
          await executeWithUserSafeDegradation({
            dependency: 'pinata',
            operation: 'fetchEncryptedContent',
            authContext: { isAuthenticated: false },
            actionFn: async () => { actionCalled = true; },
            fallbackFn: async () => { fallbackCalled = true; },
          });
        },
        (err) => {
          assert.equal(err.status, 401);
          assert.equal(err.code, 'UNAUTHENTICATED');
          return true;
        }
      );

      assert.equal(actionCalled, false);
      assert.equal(fallbackCalled, false);
    });

    it('rejects unauthorized requests lacking required permissions', async () => {
      let actionCalled = false;
      let fallbackCalled = false;

      await assert.rejects(
        async () => {
          await executeWithUserSafeDegradation({
            dependency: 'pinata',
            operation: 'manageVault',
            authContext: {
              isAuthenticated: true,
              userId: 'user_1',
              permissions: ['content:read'],
            },
            requiredPermissions: 'content:admin',
            actionFn: async () => { actionCalled = true; },
            fallbackFn: async () => { fallbackCalled = true; },
          });
        },
        (err) => {
          assert.equal(err.status, 403);
          assert.equal(err.code, 'FORBIDDEN');
          return true;
        }
      );

      assert.equal(actionCalled, false);
      assert.equal(fallbackCalled, false);
    });
  });

  describe('Normal Execution and Transient Retries', () => {
    it('executes normally when dependency is healthy', async () => {
      const result = await executeWithUserSafeDegradation({
        dependency: 'stellar',
        operation: 'getAccountBalance',
        authContext: { isAuthenticated: true, permissions: ['*'] },
        actionFn: async () => ({ balance: '150.50' }),
      });

      assert.equal(result.success, true);
      assert.equal(result.degraded, false);
      assert.deepEqual(result.data, { balance: '150.50' });
    });

    it('recovers on transient retry before falling back', async () => {
      let callCount = 0;
      const result = await executeWithUserSafeDegradation({
        dependency: 'stellar',
        operation: 'getLedgerSequence',
        maxRetries: 2,
        retryBackoffMs: 10,
        actionFn: async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error('Temporary 503 Service Unavailable');
          }
          return { sequence: 123456 };
        },
      });

      assert.equal(result.success, true);
      assert.equal(result.degraded, false);
      assert.equal(callCount, 2);
      assert.deepEqual(result.data, { sequence: 123456 });
    });
  });

  describe('Critical Financial Protection vs Non-Critical Graceful Fallback', () => {
    it('strictly blocks critical financial mutations on dependency failure', async () => {
      setDependencyHealth('stellar', DEPENDENCY_STATE.UNAVAILABLE);

      const result = await executeWithUserSafeDegradation({
        dependency: 'stellar',
        operation: 'processPurchase',
        isCriticalFinancial: true,
        actionFn: async () => { throw new Error('Stellar down'); },
      });

      assert.equal(result.success, false);
      assert.equal(result.degraded, true);
      assert.equal(result.blocked, true);
      assert.equal(result.code, 'DEPENDENCY_UNAVAILABLE_CRITICAL_BLOCKED');
      assert.ok(result.retryAfter > 0);
      assert.equal(result.error.includes('secret'), false);
    });

    it('gracefully serves fallback for non-critical content operations', async () => {
      setDependencyHealth('pinata', DEPENDENCY_STATE.UNAVAILABLE);

      const cached = { title: 'Intro to Soroban', previewAvailable: true };
      const result = await executeWithUserSafeDegradation({
        dependency: 'pinata',
        operation: 'viewCoursePreview',
        isCriticalFinancial: false,
        cachedData: cached,
        fallbackFn: async ({ cachedData }) => ({ ...cachedData, source: 'edge-cache' }),
        actionFn: async () => { throw new Error('IPFS Gateway error'); },
      });

      assert.equal(result.success, true);
      assert.equal(result.degraded, true);
      assert.equal(result.readOnly, true);
      assert.deepEqual(result.data, { title: 'Intro to Soroban', previewAvailable: true, source: 'edge-cache' });
    });

    it('emits structured telemetry events without sensitive data', async () => {
      setDependencyHealth('mongodb', DEPENDENCY_STATE.UNAVAILABLE);
      await executeWithUserSafeDegradation({
        dependency: 'mongodb',
        operation: 'queryReadReplica',
        cachedData: { cachedList: [1, 2] },
        actionFn: async () => { throw new Error('Connection refused'); },
      });

      const events = getDegradedModeEvents();
      assert.ok(events.length > 0);
      const stateEvent = events.find((e) => e.event === 'DEPENDENCY_STATE_CHANGED');
      assert.ok(stateEvent);
      assert.equal(stateEvent.dependency, 'mongodb');
      assert.equal(stateEvent.toState, 'UNAVAILABLE');
    });
  });
});

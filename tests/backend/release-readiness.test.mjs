import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  CheckStatus,
  ReleaseDecision,
  checkDeploymentAuthorization,
  checkEnvironmentReadiness,
  checkMigrationReadiness,
  runReleaseSmokeTests,
  checkRollbackReadiness,
  evaluateReleaseReadiness,
} from '../../src/lib/release/releaseReadiness.js';

describe('Release Readiness Checks (Issue #1022)', () => {
  describe('Deployment Authorization Path', () => {
    test('authorizes admin and deployer roles', () => {
      const resAdmin = checkDeploymentAuthorization({ id: 'alice', role: 'admin' });
      assert.equal(resAdmin.status, CheckStatus.PASSED);

      const resDeployer = checkDeploymentAuthorization({ id: 'bob', role: 'deployer' });
      assert.equal(resDeployer.status, CheckStatus.PASSED);

      const resPerm = checkDeploymentAuthorization({ id: 'carol', role: 'engineer', permissions: ['system:release'] });
      assert.equal(resPerm.status, CheckStatus.PASSED);
    });

    test('rejects unauthorized roles or missing actors', () => {
      const resAnon = checkDeploymentAuthorization(null);
      assert.equal(resAnon.status, CheckStatus.FAILED);

      const resLearner = checkDeploymentAuthorization({ id: 'dan', role: 'learner' });
      assert.equal(resLearner.status, CheckStatus.FAILED);
      assert.ok(resLearner.message.includes('not authorized'));
    });
  });

  describe('Environment Readiness Path', () => {
    test('passes when all required env vars are present', () => {
      const env = {
        JWT_SECRET: 'super-secret-key-1234567890',
        NEXT_PUBLIC_STELLAR_NETWORK: 'TESTNET',
      };
      const res = checkEnvironmentReadiness(env);
      assert.equal(res.status, CheckStatus.PASSED);
    });

    test('fails when required secrets are missing', () => {
      const env = {
        NEXT_PUBLIC_STELLAR_NETWORK: 'TESTNET',
      };
      const res = checkEnvironmentReadiness(env);
      assert.equal(res.status, CheckStatus.FAILED);
      assert.ok(res.message.includes('JWT_SECRET'));
    });
  });

  describe('Migration Readiness Path', () => {
    test('passes when all required collections and reversible migrations are present', async () => {
      const mockDb = {
        listCollections: () => ({
          toArray: async () => [
            { name: 'users' },
            { name: 'materials' },
            { name: 'purchases' },
            { name: 'entitlement_cache' },
            { name: 'refunds' },
            { name: 'audit_ledger' },
          ],
        }),
      };

      const res = await checkMigrationReadiness({
        db: mockDb,
        registeredMigrations: [
          { id: 'mig-1', applied: true, reversible: true },
        ],
      });
      assert.equal(res.status, CheckStatus.PASSED);
    });

    test('fails when irreversible migrations are pending', async () => {
      const mockDb = {
        listCollections: () => ({
          toArray: async () => [
            { name: 'users' },
            { name: 'materials' },
            { name: 'purchases' },
            { name: 'entitlement_cache' },
            { name: 'refunds' },
            { name: 'audit_ledger' },
          ],
        }),
      };

      const res = await checkMigrationReadiness({
        db: mockDb,
        registeredMigrations: [
          { id: 'mig-breaking-schema', applied: false, reversible: false },
        ],
      });
      assert.equal(res.status, CheckStatus.FAILED);
      assert.ok(res.message.includes('Irreversible pending migrations'));
    });
  });

  describe('Smoke Tests with Retry Logic', () => {
    test('succeeds on first attempt when canary cycle completes', async () => {
      const store = new Map();
      const mockDb = {
        collection: () => ({
          insertOne: async (doc) => store.set(doc._id, doc),
          findOne: async (query) => store.get(query._id) || null,
          deleteOne: async (query) => store.delete(query._id),
        }),
      };

      const res = await runReleaseSmokeTests({ db: mockDb });
      assert.equal(res.status, CheckStatus.PASSED);
      assert.equal(res.retries, 0);
    });

    test('recovers after transient failure via retry', async () => {
      let callCount = 0;
      const store = new Map();
      const mockDb = {
        collection: () => ({
          insertOne: async (doc) => {
            callCount++;
            if (callCount === 1) {
              throw new Error('Transient socket reset');
            }
            store.set(doc._id, doc);
          },
          findOne: async (query) => store.get(query._id) || null,
          deleteOne: async (query) => store.delete(query._id),
        }),
      };

      const res = await runReleaseSmokeTests({ db: mockDb, maxRetries: 3, retryDelayMs: 10 });
      assert.equal(res.status, CheckStatus.PASSED);
      assert.equal(res.retries, 1);
    });
  });

  describe('Rollback Readiness Path', () => {
    test('passes when fresh verified backup snapshot exists and rehearsal done', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
      const res = checkRollbackReadiness({
        lastBackupTimestamp: twoHoursAgo,
        hasRehearsedRollback: true,
      });
      assert.equal(res.status, CheckStatus.PASSED);
    });

    test('fails when no backup timestamp exists', () => {
      const res = checkRollbackReadiness({ lastBackupTimestamp: null });
      assert.equal(res.status, CheckStatus.FAILED);
      assert.ok(res.message.includes('No verified backup'));
    });

    test('warns when backup is stale (>24h)', () => {
      const thirtyHoursAgo = new Date(Date.now() - 30 * 3600000).toISOString();
      const res = checkRollbackReadiness({
        lastBackupTimestamp: thirtyHoursAgo,
        maxBackupAgeHours: 24,
      });
      assert.equal(res.status, CheckStatus.WARNING);
    });
  });

  describe('evaluateReleaseReadiness Orchestrator', () => {
    test('produces PROCEED decision when all criteria pass', async () => {
      const store = new Map();
      const mockDb = {
        listCollections: () => ({
          toArray: async () => [
            { name: 'users' },
            { name: 'materials' },
            { name: 'purchases' },
            { name: 'entitlement_cache' },
            { name: 'refunds' },
            { name: 'audit_ledger' },
          ],
        }),
        collection: () => ({
          insertOne: async (doc) => store.set(doc._id, doc),
          findOne: async (query) => store.get(query._id) || null,
          deleteOne: async (query) => store.delete(query._id),
        }),
      };

      const report = await evaluateReleaseReadiness({
        actor: { id: 'lead-dev', role: 'admin' },
        db: mockDb,
        env: {
          JWT_SECRET: 'test-secret',
          NEXT_PUBLIC_STELLAR_NETWORK: 'TESTNET',
        },
        rollbackOpts: {
          lastBackupTimestamp: new Date().toISOString(),
          hasRehearsedRollback: true,
        },
      });

      assert.equal(report.decision, ReleaseDecision.PROCEED);
      assert.equal(report.summary.failed, 0);
      assert.ok(report.releaseId.startsWith('rel-'));
    });

    test('blocks release if any check fails', async () => {
      const report = await evaluateReleaseReadiness({
        actor: { id: 'unauthorized-user', role: 'guest' },
        db: null,
      });

      assert.equal(report.decision, ReleaseDecision.BLOCKED);
      assert.ok(report.summary.failed > 0);
    });
  });
});

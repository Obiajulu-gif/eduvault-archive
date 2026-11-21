import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectContributorDiagnostics,
  runContributorDiagnostics,
  assertContributorDiagnosticsAuthorized,
  ContributorDiagnosticsAuthorizationError,
  ENVIRONMENT_KEYS,
} from '../../src/lib/health/contributorDiagnostics.js';
import { DEPENDENCY_STATUS } from '../../src/lib/health/dependencyChecker.js';

describe('contributor diagnostics (#1154)', () => {
  describe('normal path', () => {
    it('collects diagnostic report with runtime, environment presence, and sanitization', () => {
      const mockEnv = {
        MONGODB_URI: 'mongodb://user:superSecretPassword@localhost:27017/eduvault',
        PINATA_JWT: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummySecretKey',
      };

      const mockDependencyReport = {
        status: DEPENDENCY_STATUS.HEALTHY,
        dependencies: {
          database: { name: 'database', status: 'healthy', message: 'MongoDB ping ok' },
        },
        remediations: [],
      };

      const report = collectContributorDiagnostics({
        env: mockEnv,
        dependencyReport: mockDependencyReport,
      });

      assert.equal(report.status, DEPENDENCY_STATUS.HEALTHY);
      assert.equal(report.environment.MONGODB_URI, true);
      assert.equal(report.environment.PINATA_JWT, true);
      assert.equal(report.environment.NEXT_PUBLIC_STELLAR_RPC_URL, false);

      // Verify strict secrecy - no password or token leaked
      const serialized = JSON.stringify(report);
      assert.equal(serialized.includes('superSecretPassword'), false);
      assert.equal(serialized.includes('dummySecretKey'), false);

      assert.ok(report.runtime.node.startsWith('v'));
      assert.ok(report.packageManager.lockfiles.includes('package-lock.json'));
      assert.equal(report.retryable, false);
    });

    it('exports all expected environment keys for contributor verification', () => {
      assert.ok(ENVIRONMENT_KEYS.includes('MONGODB_URI'));
      assert.ok(ENVIRONMENT_KEYS.includes('PINATA_JWT'));
      assert.ok(ENVIRONMENT_KEYS.includes('NEXT_PUBLIC_STELLAR_RPC_URL'));
      assert.ok(ENVIRONMENT_KEYS.includes('NEXT_PUBLIC_HORIZON_URL'));
      assert.ok(ENVIRONMENT_KEYS.includes('NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID'));
      assert.ok(ENVIRONMENT_KEYS.includes('NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID'));
    });
  });

  describe('failure path', () => {
    it('flags misconfigured dependencies with remediation hints', () => {
      const mockDependencyReport = {
        status: DEPENDENCY_STATUS.MISCONFIGURED,
        remediations: [
          { dependency: 'database', status: 'misconfigured', hint: 'Configure MONGODB_URI in .env.local.' },
        ],
      };

      const report = collectContributorDiagnostics({
        env: {},
        dependencyReport: mockDependencyReport,
      });

      assert.equal(report.status, DEPENDENCY_STATUS.MISCONFIGURED);
      assert.equal(report.remediation.length >= 1, true);
      assert.equal(report.remediation.some((r) => r.dependency === 'database'), true);
      assert.equal(report.retryable, false);
    });
  });

  describe('retry path', () => {
    it('retries transiently unavailable dependencies with backoff', async () => {
      let callCount = 0;
      const sleepDelays = [];

      const options = {
        retries: 2,
        retryDelayMs: 25,
        sleep: async (ms) => { sleepDelays.push(ms); },
        // Custom fake dependency checker via options
        dependencyReport: null,
      };

      // Mock checkAllDependencies behavior by passing resolved dependencyReport on 3rd attempt
      let attempts = 0;
      const originalRunner = async () => {
        attempts++;
        if (attempts < 3) {
          return { status: DEPENDENCY_STATUS.UNAVAILABLE, remediations: [] };
        }
        return { status: DEPENDENCY_STATUS.HEALTHY, remediations: [] };
      };

      // Run diagnostics passing custom dependency resolver
      let currentAttempt = 0;
      const customOptions = {
        retries: 2,
        retryDelayMs: 20,
        sleep: async (ms) => { sleepDelays.push(ms); },
        get dependencyReport() {
          currentAttempt++;
          if (currentAttempt < 3) {
            return { status: DEPENDENCY_STATUS.UNAVAILABLE, remediations: [] };
          }
          return { status: DEPENDENCY_STATUS.HEALTHY, remediations: [] };
        },
      };

      const result = await runContributorDiagnostics(customOptions);
      assert.equal(result.status, DEPENDENCY_STATUS.HEALTHY);
      assert.equal(result.retryAttempts, 2);
      assert.equal(sleepDelays.length, 2);
      assert.equal(sleepDelays[0], 20);
      assert.equal(sleepDelays[1], 40);
    });

    it('marks report as retryable when status is UNAVAILABLE', () => {
      const report = collectContributorDiagnostics({
        env: {},
        dependencyReport: { status: DEPENDENCY_STATUS.UNAVAILABLE, remediations: [] },
      });
      assert.equal(report.status, DEPENDENCY_STATUS.UNAVAILABLE);
      assert.equal(report.retryable, true);
    });
  });

  describe('authorization path', () => {
    it('assertContributorDiagnosticsAuthorized permits contributor, operator, admin, and service', () => {
      assert.doesNotThrow(() => assertContributorDiagnosticsAuthorized({ role: 'contributor' }));
      assert.doesNotThrow(() => assertContributorDiagnosticsAuthorized({ role: 'operator' }));
      assert.doesNotThrow(() => assertContributorDiagnosticsAuthorized({ role: 'admin' }));
      assert.doesNotThrow(() => assertContributorDiagnosticsAuthorized({ role: 'service' }));
    });

    it('assertContributorDiagnosticsAuthorized rejects unauthorized roles or missing actors', () => {
      assert.throws(() => assertContributorDiagnosticsAuthorized(null), ContributorDiagnosticsAuthorizationError);
      assert.throws(() => assertContributorDiagnosticsAuthorized({ role: 'guest' }), ContributorDiagnosticsAuthorizationError);
      assert.throws(() => assertContributorDiagnosticsAuthorized({ role: 'learner' }), ContributorDiagnosticsAuthorizationError);
    });

    it('runContributorDiagnostics enforces authorization when actor option is supplied', async () => {
      await assert.rejects(
        async () => {
          await runContributorDiagnostics({
            actor: { role: 'unauthorized_user' },
            dependencyReport: { status: DEPENDENCY_STATUS.HEALTHY },
          });
        },
        ContributorDiagnosticsAuthorizationError
      );

      const success = await runContributorDiagnostics({
        actor: { role: 'contributor' },
        dependencyReport: { status: DEPENDENCY_STATUS.HEALTHY },
      });
      assert.equal(success.status, DEPENDENCY_STATUS.HEALTHY);
    });
  });
});

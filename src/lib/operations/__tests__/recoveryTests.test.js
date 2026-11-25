/**
 * Tests for Deterministic Recovery Tests Framework
 * Issue #3
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createStateSnapshot,
  recordRecoveryTest,
  testRecoveryFromInterruption,
  runRecoveryTestSuite,
  testRollbackFromInterruption,
  getRecoveryTestHistory,
  generateRecoveryTestReport,
  InterruptionPoint,
  RecoveryTestStatus,
  RecoveryTestError,
} from '../recoveryTests.js';

// Mock logger
vi.mock('../../logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

function createMockCollection(initialDocs = []) {
  const docs = [...initialDocs];

  return {
    _docs: docs,
    async findOne(query) {
      return docs.find((d) => {
        if (query.testId) return d.testId === query.testId;
        return true;
      }) || null;
    },
    find(query = {}) {
      let filtered = docs;
      if (query.operationType) {
        filtered = docs.filter(d => d.operationType === query.operationType);
      }
      if (query.interruptionPoint) {
        filtered = docs.filter(d => d.interruptionPoint === query.interruptionPoint);
      }
      if (query.status) {
        filtered = docs.filter(d => d.status === query.status);
      }
      if (query.testedAt && query.testedAt.$gte) {
        filtered = docs.filter(d => d.testedAt >= query.testedAt.$gte);
      }
      return {
        sort() {
          return {
            limit(n) {
              return {
                toArray: async () => filtered.slice(0, n),
              };
            },
          };
        },
        toArray: async () => filtered,
      };
    },
    async insertOne(doc) {
      docs.push({ ...doc });
      return { acknowledged: true, insertedId: doc.testId };
    },
  };
}

const mockDb = {
  collection: vi.fn(),
};

vi.mock('../../mongodb.js', () => ({
  getDb: vi.fn(() => Promise.resolve(mockDb)),
}));

describe('Deterministic Recovery Tests Framework', () => {
  let mockCollection;
  const testActor = { id: 'test_user', sub: 'test_user', role: 'admin', permissions: ['test:execute'] };

  beforeEach(() => {
    mockCollection = createMockCollection([]);
    mockDb.collection.mockReturnValue(mockCollection);
    vi.clearAllMocks();
  });

  describe('State Snapshot Creation', () => {
    it('creates deterministic state snapshot', () => {
      const snapshot = createStateSnapshot({
        operationId: 'op_test_001',
        operationType: 'purchase',
        interruptionPoint: InterruptionPoint.AFTER_VALIDATION,
        state: {
          step: 'validated',
          data: { amount: 100, currency: 'USD' },
        },
        metadata: { testRun: true },
        actor: testActor,
      });

      expect(snapshot.operationId).toBe('op_test_001');
      expect(snapshot.operationType).toBe('purchase');
      expect(snapshot.interruptionPoint).toBe(InterruptionPoint.AFTER_VALIDATION);
      expect(snapshot.stateHash).toHaveLength(64); // SHA-256 hash
      expect(snapshot.actor.id).toBe('test_user');
    });

    it('produces same hash for identical state', () => {
      const state = {
        step: 'processing',
        data: { value: 42 },
      };

      const snapshot1 = createStateSnapshot({
        operationId: 'op_001',
        operationType: 'test',
        interruptionPoint: InterruptionPoint.DURING_EXECUTION,
        state,
        actor: testActor,
      });

      const snapshot2 = createStateSnapshot({
        operationId: 'op_001',
        operationType: 'test',
        interruptionPoint: InterruptionPoint.DURING_EXECUTION,
        state,
        actor: testActor,
      });

      expect(snapshot1.stateHash).toBe(snapshot2.stateHash);
    });

    it('requires mandatory fields', () => {
      expect(() =>
        createStateSnapshot({
          // Missing operationId
          operationType: 'test',
          interruptionPoint: InterruptionPoint.BEFORE_START,
          state: {},
        })
      ).toThrow(RecoveryTestError);
    });
  });

  describe('Normal Path - Successful Recovery', () => {
    it('tests recovery from interruption point', async () => {
      const initialState = {
        step: 'interrupted',
        processedItems: 5,
        totalItems: 10,
      };

      const expectedFinalState = {
        step: 'completed',
        processedItems: 10,
        totalItems: 10,
      };

      const recoveryFunction = async (snapshot) => {
        // Simulate recovery logic
        return {
          step: 'completed',
          processedItems: snapshot.state.totalItems,
          totalItems: snapshot.state.totalItems,
          actor: snapshot.actor,
        };
      };

      const result = await testRecoveryFromInterruption({
        operationId: 'op_recovery_001',
        operationType: 'batch_process',
        interruptionPoint: InterruptionPoint.DURING_EXECUTION,
        initialState,
        recoveryFunction,
        expectedFinalState,
        actor: testActor,
      });

      expect(result.status).toBe(RecoveryTestStatus.PASSED);
      expect(result.errors).toHaveLength(0);
      expect(result.duration).toBeGreaterThan(0);
    });

    it('verifies idempotency of recovery', async () => {
      let executionCount = 0;

      const recoveryFunction = async (snapshot) => {
        executionCount++;
        return {
          recovered: true,
          executionCount,
          actor: snapshot.actor,
        };
      };

      const result = await testRecoveryFromInterruption({
        operationId: 'op_idempotent',
        operationType: 'test',
        interruptionPoint: InterruptionPoint.AFTER_VALIDATION,
        initialState: { step: 'interrupted' },
        recoveryFunction,
        expectedFinalState: { recovered: true, executionCount: 1, actor: testActor },
        actor: testActor,
      });

      // Recovery function is called twice internally to verify idempotency
      expect(executionCount).toBe(2);
      expect(result.status).toBe(RecoveryTestStatus.PASSED);
    });
  });

  describe('Failure Path - Recovery Failures', () => {
    it('detects state mismatch after recovery', async () => {
      const recoveryFunction = async () => ({
        step: 'wrong_state',
      });

      const result = await testRecoveryFromInterruption({
        operationId: 'op_mismatch',
        operationType: 'test',
        interruptionPoint: InterruptionPoint.BEFORE_FINALIZATION,
        initialState: { step: 'interrupted' },
        recoveryFunction,
        expectedFinalState: { step: 'completed' },
        actor: testActor,
      });

      expect(result.status).toBe(RecoveryTestStatus.FAILED);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].type).toBe('state_mismatch');
    });

    it('detects non-idempotent recovery', async () => {
      let counter = 0;

      const nonIdempotentRecovery = async () => {
        counter++;
        return {
          step: 'completed',
          randomValue: Math.random(), // Non-deterministic
        };
      };

      const result = await testRecoveryFromInterruption({
        operationId: 'op_non_idempotent',
        operationType: 'test',
        interruptionPoint: InterruptionPoint.DURING_EXECUTION,
        initialState: { step: 'interrupted' },
        recoveryFunction: nonIdempotentRecovery,
        expectedFinalState: { step: 'completed', randomValue: 0.5 },
        actor: testActor,
      });

      expect(result.status).toBe(RecoveryTestStatus.FAILED);
      expect(result.errors.some(e => e.type === 'not_idempotent')).toBe(true);
    });

    it('handles recovery function errors', async () => {
      const failingRecovery = async () => {
        throw new Error('Recovery failed unexpectedly');
      };

      const result = await testRecoveryFromInterruption({
        operationId: 'op_error',
        operationType: 'test',
        interruptionPoint: InterruptionPoint.AFTER_PARTIAL_COMMIT,
        initialState: { step: 'interrupted' },
        recoveryFunction: failingRecovery,
        expectedFinalState: { step: 'completed' },
        actor: testActor,
      });

      expect(result.status).toBe(RecoveryTestStatus.FAILED);
      expect(result.errors[0].type).toBe('recovery_failure');
      expect(result.errors[0].message).toContain('Recovery failed unexpectedly');
    });
  });

  describe('Authorization Preservation', () => {
    it('verifies actor authorization is preserved through recovery', async () => {
      const recoveryFunction = async (snapshot) => ({
        step: 'completed',
        actor: snapshot.actor,
      });

      const result = await testRecoveryFromInterruption({
        operationId: 'op_auth',
        operationType: 'test',
        interruptionPoint: InterruptionPoint.BEFORE_FINALIZATION,
        initialState: { step: 'interrupted' },
        recoveryFunction,
        expectedFinalState: {
          step: 'completed',
          actor: testActor,
        },
        actor: testActor,
      });

      expect(result.status).toBe(RecoveryTestStatus.PASSED);
    });

    it('detects authorization loss during recovery', async () => {
      const recoveryFunction = async () => ({
        step: 'completed',
        actor: { id: 'wrong_user', role: 'user' }, // Wrong actor
      });

      const result = await testRecoveryFromInterruption({
        operationId: 'op_auth_loss',
        operationType: 'test',
        interruptionPoint: InterruptionPoint.DURING_EXECUTION,
        initialState: { step: 'interrupted' },
        recoveryFunction,
        expectedFinalState: {
          step: 'completed',
          actor: { id: 'wrong_user', role: 'user' },
        },
        actor: testActor,
      });

      expect(result.status).toBe(RecoveryTestStatus.FAILED);
      expect(result.errors.some(e => e.type === 'authorization_lost')).toBe(true);
    });
  });

  describe('Recovery Test Suite', () => {
    it('runs comprehensive test suite across all interruption points', async () => {
      const setupFunction = async (interruptionPoint) => ({
        initialState: {
          step: interruptionPoint,
          data: { value: 100 },
        },
        expectedFinalState: {
          step: 'completed',
          data: { value: 100 },
        },
      });

      const recoveryFunction = async (snapshot) => ({
        step: 'completed',
        data: snapshot.state.data,
      });

      const results = await runRecoveryTestSuite({
        operationType: 'comprehensive_test',
        operationId: 'suite_001',
        setupFunction,
        recoveryFunction,
        interruptionPoints: [
          InterruptionPoint.AFTER_VALIDATION,
          InterruptionPoint.DURING_EXECUTION,
          InterruptionPoint.BEFORE_FINALIZATION,
        ],
        actor: testActor,
      });

      expect(results.totalTests).toBe(3);
      expect(results.passed).toBe(3);
      expect(results.failed).toBe(0);
      expect(results.tests).toHaveLength(3);
    });

    it('continues suite even if individual tests fail', async () => {
      let callCount = 0;

      const setupFunction = async (interruptionPoint) => ({
        initialState: { step: interruptionPoint },
        expectedFinalState: { step: 'completed' },
      });

      const recoveryFunction = async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Simulated failure');
        }
        return { step: 'completed' };
      };

      const results = await runRecoveryTestSuite({
        operationType: 'partial_failure',
        operationId: 'suite_002',
        setupFunction,
        recoveryFunction,
        interruptionPoints: [
          InterruptionPoint.BEFORE_START,
          InterruptionPoint.DURING_EXECUTION,
          InterruptionPoint.AFTER_COMPLETION,
        ],
        actor: testActor,
      });

      expect(results.totalTests).toBe(3);
      expect(results.passed).toBe(2);
      expect(results.failed).toBe(1);
    });
  });

  describe('Rollback Testing', () => {
    it('tests rollback from interruption point', async () => {
      const interruptedState = {
        step: 'partially_committed',
        committedRecords: 5,
        pendingRecords: 5,
      };

      const expectedRollbackState = {
        step: 'rolled_back',
        committedRecords: 0,
        pendingRecords: 0,
      };

      const rollbackFunction = async () => ({
        step: 'rolled_back',
        committedRecords: 0,
        pendingRecords: 0,
      });

      const result = await testRollbackFromInterruption({
        operationId: 'op_rollback',
        operationType: 'batch_insert',
        interruptionPoint: InterruptionPoint.AFTER_PARTIAL_COMMIT,
        interruptedState,
        rollbackFunction,
        expectedRollbackState,
        actor: testActor,
      });

      expect(result.status).toBe(RecoveryTestStatus.PASSED);
    });

    it('verifies rollback idempotency', async () => {
      let rollbackCount = 0;

      const rollbackFunction = async () => {
        rollbackCount++;
        return {
          step: 'rolled_back',
          rollbackCount,
        };
      };

      const result = await testRollbackFromInterruption({
        operationId: 'op_rollback_idempotent',
        operationType: 'test',
        interruptionPoint: InterruptionPoint.DURING_EXECUTION,
        interruptedState: { step: 'interrupted' },
        rollbackFunction,
        expectedRollbackState: { step: 'rolled_back', rollbackCount: 1 },
        actor: testActor,
      });

      // Rollback is called twice to verify idempotency
      expect(rollbackCount).toBe(2);
      expect(result.status).toBe(RecoveryTestStatus.PASSED);
    });
  });

  describe('Test History and Reporting', () => {
    it('retrieves recovery test history', async () => {
      // Create some test records
      await recordRecoveryTest({
        testId: 'test_001',
        operationType: 'purchase',
        interruptionPoint: InterruptionPoint.DURING_EXECUTION,
        snapshot: createStateSnapshot({
          operationId: 'op_001',
          operationType: 'purchase',
          interruptionPoint: InterruptionPoint.DURING_EXECUTION,
          state: {},
        }),
        recoveryFunction: 'testFunction',
        expectedOutcome: {},
        actualOutcome: {},
        passed: true,
        duration: 100,
      });

      const history = await getRecoveryTestHistory({
        operationType: 'purchase',
        limit: 10,
      });

      expect(history).toHaveLength(1);
      expect(history[0].testId).toBe('test_001');
    });

    it('generates comprehensive recovery test report', async () => {
      // Create test data
      await recordRecoveryTest({
        testId: 'report_test_1',
        operationType: 'refund',
        interruptionPoint: InterruptionPoint.AFTER_VALIDATION,
        snapshot: createStateSnapshot({
          operationId: 'op_report_1',
          operationType: 'refund',
          interruptionPoint: InterruptionPoint.AFTER_VALIDATION,
          state: {},
        }),
        recoveryFunction: 'recover',
        expectedOutcome: {},
        actualOutcome: {},
        passed: true,
        duration: 150,
      });

      await recordRecoveryTest({
        testId: 'report_test_2',
        operationType: 'refund',
        interruptionPoint: InterruptionPoint.DURING_EXECUTION,
        snapshot: createStateSnapshot({
          operationId: 'op_report_2',
          operationType: 'refund',
          interruptionPoint: InterruptionPoint.DURING_EXECUTION,
          state: {},
        }),
        recoveryFunction: 'recover',
        expectedOutcome: {},
        actualOutcome: {},
        passed: false,
        duration: 200,
        errors: [{ type: 'test_error' }],
      });

      const report = await generateRecoveryTestReport({
        operationType: 'refund',
      });

      expect(report.totalTests).toBe(2);
      expect(report.byStatus[RecoveryTestStatus.PASSED]).toBe(1);
      expect(report.byStatus[RecoveryTestStatus.FAILED]).toBe(1);
      expect(report.byOperationType.refund.total).toBe(2);
      expect(report.byOperationType.refund.passed).toBe(1);
      expect(report.byOperationType.refund.failed).toBe(1);
      expect(report.averageDuration).toBe(175);
      expect(report.failureRate).toBe(50);
    });
  });

  describe('Edge Cases and Retry Scenarios', () => {
    it('handles recovery from before_start interruption', async () => {
      const recoveryFunction = async (snapshot) => ({
        step: 'started',
        actor: snapshot.actor,
      });

      const result = await testRecoveryFromInterruption({
        operationId: 'op_before_start',
        operationType: 'test',
        interruptionPoint: InterruptionPoint.BEFORE_START,
        initialState: { step: 'not_started' },
        recoveryFunction,
        expectedFinalState: { step: 'started', actor: testActor },
        actor: testActor,
      });

      expect(result.status).toBe(RecoveryTestStatus.PASSED);
    });

    it('handles recovery from after_completion interruption', async () => {
      const recoveryFunction = async (snapshot) => ({
        ...snapshot.state,
        verified: true,
      });

      const result = await testRecoveryFromInterruption({
        operationId: 'op_after_complete',
        operationType: 'test',
        interruptionPoint: InterruptionPoint.AFTER_COMPLETION,
        initialState: { step: 'completed', data: 'value' },
        recoveryFunction,
        expectedFinalState: { step: 'completed', data: 'value', verified: true },
        actor: testActor,
      });

      expect(result.status).toBe(RecoveryTestStatus.PASSED);
    });

    it('handles complex state objects', async () => {
      const complexState = {
        metadata: {
          id: 'complex_001',
          nested: {
            deep: {
              value: 42,
            },
          },
        },
        arrays: [1, 2, 3],
        dates: [new Date('2024-01-01')],
      };

      const snapshot = createStateSnapshot({
        operationId: 'op_complex',
        operationType: 'complex_test',
        interruptionPoint: InterruptionPoint.DURING_EXECUTION,
        state: complexState,
        actor: testActor,
      });

      expect(snapshot.stateHash).toHaveLength(64);
      expect(snapshot.state.metadata.nested.deep.value).toBe(42);
    });
  });
});

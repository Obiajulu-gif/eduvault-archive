/**
 * Deterministic Recovery Tests for Interrupted Multi-Step Operations (Issue #3)
 * 
 * Provides:
 * 1. Deterministic state snapshots for interrupted operations
 * 2. Recovery verification from any interruption point
 * 3. Idempotency testing across retry scenarios
 * 4. Authorization preservation through recovery
 * 5. Edge case documentation and rollback verification
 */

import { getDb } from '../mongodb.js';
import logger from '../logger.js';
import crypto from 'node:crypto';

export const RECOVERY_TEST_VERSION = 'v1';

/**
 * Interruption points for multi-step operations
 */
export const InterruptionPoint = Object.freeze({
  BEFORE_START: 'before_start',
  AFTER_VALIDATION: 'after_validation',
  DURING_EXECUTION: 'during_execution',
  AFTER_PARTIAL_COMMIT: 'after_partial_commit',
  BEFORE_FINALIZATION: 'before_finalization',
  AFTER_COMPLETION: 'after_completion',
});

/**
 * Recovery test status
 */
export const RecoveryTestStatus = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

/**
 * Error class for recovery test operations
 */
export class RecoveryTestError extends Error {
  constructor(message, code = 'RECOVERY_TEST_ERROR', details = null) {
    super(message);
    this.name = 'RecoveryTestError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Create a state snapshot for recovery testing
 */
export function createStateSnapshot({
  operationId,
  operationType,
  interruptionPoint,
  state,
  metadata = {},
  actor = null,
}) {
  if (!operationId || !operationType || !interruptionPoint) {
    throw new RecoveryTestError(
      'operationId, operationType, and interruptionPoint are required',
      'MISSING_REQUIRED_FIELDS'
    );
  }

  const snapshot = {
    version: RECOVERY_TEST_VERSION,
    snapshotId: `snap_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    operationId: String(operationId),
    operationType: String(operationType),
    interruptionPoint: String(interruptionPoint),
    state: JSON.parse(JSON.stringify(state)), // Deep clone
    metadata: JSON.parse(JSON.stringify(metadata)),
    actor: actor ? {
      id: String(actor.id || actor.sub || actor),
      role: actor.role,
      permissions: actor.permissions || [],
    } : null,
    createdAt: new Date(),
    stateHash: null, // Will be computed
  };

  // Compute deterministic hash of state
  const stateString = JSON.stringify({
    operationId: snapshot.operationId,
    interruptionPoint: snapshot.interruptionPoint,
    state: snapshot.state,
  });
  snapshot.stateHash = crypto.createHash('sha256').update(stateString).digest('hex');

  return snapshot;
}

/**
 * Record a recovery test result
 */
export async function recordRecoveryTest({
  testId,
  operationType,
  interruptionPoint,
  snapshot,
  recoveryFunction,
  expectedOutcome,
  actualOutcome,
  passed,
  duration,
  errors = [],
  metadata = {},
}) {
  const db = await getDb();
  const collection = db.collection('recovery_tests');

  const testRecord = {
    version: RECOVERY_TEST_VERSION,
    testId: String(testId),
    operationType: String(operationType),
    interruptionPoint: String(interruptionPoint),
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.stateHash,
    recoveryFunction: String(recoveryFunction),
    expectedOutcome: JSON.parse(JSON.stringify(expectedOutcome)),
    actualOutcome: JSON.parse(JSON.stringify(actualOutcome)),
    status: passed ? RecoveryTestStatus.PASSED : RecoveryTestStatus.FAILED,
    duration,
    errors: Array.isArray(errors) ? errors : [],
    metadata: JSON.parse(JSON.stringify(metadata)),
    testedAt: new Date(),
  };

  await collection.insertOne(testRecord);

  logger.info(
    {
      testId,
      operationType,
      interruptionPoint,
      passed,
      duration,
    },
    '[RecoveryTests] Recorded recovery test result'
  );

  return testRecord;
}

/**
 * Test recovery from a specific interruption point
 */
export async function testRecoveryFromInterruption({
  operationId,
  operationType,
  interruptionPoint,
  initialState,
  recoveryFunction,
  expectedFinalState,
  actor = null,
  metadata = {},
}) {
  const testId = `test_${operationType}_${interruptionPoint}_${Date.now()}`;
  const startTime = Date.now();

  logger.info(
    { testId, operationType, interruptionPoint },
    '[RecoveryTests] Starting recovery test'
  );

  // Create snapshot
  const snapshot = createStateSnapshot({
    operationId,
    operationType,
    interruptionPoint,
    state: initialState,
    metadata,
    actor,
  });

  const errors = [];
  let actualOutcome = null;
  let passed = false;

  try {
    // Execute recovery
    actualOutcome = await recoveryFunction(snapshot);

    // Verify outcome matches expected state
    const outcomeHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(actualOutcome))
      .digest('hex');
    const expectedHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(expectedFinalState))
      .digest('hex');

    passed = outcomeHash === expectedHash;

    if (!passed) {
      errors.push({
        type: 'state_mismatch',
        message: 'Recovered state does not match expected state',
        expected: expectedFinalState,
        actual: actualOutcome,
      });
    }

    // Verify actor authorization is preserved
    if (actor && actualOutcome.actor) {
      if (actualOutcome.actor.id !== actor.id) {
        passed = false;
        errors.push({
          type: 'authorization_lost',
          message: 'Actor authorization not preserved through recovery',
          expectedActor: actor.id,
          actualActor: actualOutcome.actor.id,
        });
      }
    }

    // Verify idempotency - running recovery again should produce same result
    const secondRecovery = await recoveryFunction(snapshot);
    const secondHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(secondRecovery))
      .digest('hex');

    if (outcomeHash !== secondHash) {
      passed = false;
      errors.push({
        type: 'not_idempotent',
        message: 'Recovery function is not idempotent',
        firstResult: actualOutcome,
        secondResult: secondRecovery,
      });
    }
  } catch (error) {
    passed = false;
    errors.push({
      type: 'recovery_failure',
      message: error.message,
      stack: error.stack,
    });
  }

  const duration = Date.now() - startTime;

  // Record test result
  const testRecord = await recordRecoveryTest({
    testId,
    operationType,
    interruptionPoint,
    snapshot,
    recoveryFunction: recoveryFunction.name || 'anonymous',
    expectedOutcome: expectedFinalState,
    actualOutcome,
    passed,
    duration,
    errors,
    metadata,
  });

  logger.info(
    {
      testId,
      operationType,
      interruptionPoint,
      passed,
      duration,
      errorCount: errors.length,
    },
    '[RecoveryTests] Completed recovery test'
  );

  return testRecord;
}

/**
 * Run a comprehensive recovery test suite for an operation
 */
export async function runRecoveryTestSuite({
  operationType,
  operationId,
  setupFunction,
  recoveryFunction,
  cleanupFunction = null,
  interruptionPoints = Object.values(InterruptionPoint),
  actor = null,
}) {
  logger.info(
    { operationType, operationId, interruptionPoints: interruptionPoints.length },
    '[RecoveryTests] Starting recovery test suite'
  );

  const results = {
    operationType,
    operationId,
    totalTests: interruptionPoints.length,
    passed: 0,
    failed: 0,
    duration: 0,
    tests: [],
  };

  const suiteStartTime = Date.now();

  for (const point of interruptionPoints) {
    try {
      // Setup initial state for this interruption point
      const { initialState, expectedFinalState } = await setupFunction(point);

      // Run test
      const testResult = await testRecoveryFromInterruption({
        operationId: `${operationId}_${point}`,
        operationType,
        interruptionPoint: point,
        initialState,
        recoveryFunction,
        expectedFinalState,
        actor,
        metadata: { suite: operationType },
      });

      results.tests.push(testResult);

      if (testResult.status === RecoveryTestStatus.PASSED) {
        results.passed++;
      } else {
        results.failed++;
      }

      // Cleanup after each test
      if (cleanupFunction) {
        await cleanupFunction(testResult);
      }
    } catch (error) {
      logger.error(
        {
          operationType,
          interruptionPoint: point,
          error: error.message,
        },
        '[RecoveryTests] Test setup failed'
      );

      results.failed++;
      results.tests.push({
        testId: `${operationType}_${point}_failed`,
        operationType,
        interruptionPoint: point,
        status: RecoveryTestStatus.FAILED,
        errors: [{ type: 'setup_failure', message: error.message }],
      });
    }
  }

  results.duration = Date.now() - suiteStartTime;

  logger.info(
    {
      operationType,
      operationId,
      passed: results.passed,
      failed: results.failed,
      duration: results.duration,
    },
    '[RecoveryTests] Completed recovery test suite'
  );

  return results;
}

/**
 * Verify rollback behavior from interruption point
 */
export async function testRollbackFromInterruption({
  operationId,
  operationType,
  interruptionPoint,
  interruptedState,
  rollbackFunction,
  expectedRollbackState,
  actor = null,
}) {
  const testId = `rollback_${operationType}_${interruptionPoint}_${Date.now()}`;
  const startTime = Date.now();

  logger.info(
    { testId, operationType, interruptionPoint },
    '[RecoveryTests] Starting rollback test'
  );

  const snapshot = createStateSnapshot({
    operationId,
    operationType,
    interruptionPoint,
    state: interruptedState,
    metadata: { testType: 'rollback' },
    actor,
  });

  const errors = [];
  let actualOutcome = null;
  let passed = false;

  try {
    // Execute rollback
    actualOutcome = await rollbackFunction(snapshot);

    // Verify rollback matches expected state
    const outcomeHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(actualOutcome))
      .digest('hex');
    const expectedHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(expectedRollbackState))
      .digest('hex');

    passed = outcomeHash === expectedHash;

    if (!passed) {
      errors.push({
        type: 'rollback_state_mismatch',
        message: 'Rolled back state does not match expected state',
        expected: expectedRollbackState,
        actual: actualOutcome,
      });
    }

    // Verify rollback is idempotent
    const secondRollback = await rollbackFunction(snapshot);
    const secondHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(secondRollback))
      .digest('hex');

    if (outcomeHash !== secondHash) {
      passed = false;
      errors.push({
        type: 'rollback_not_idempotent',
        message: 'Rollback function is not idempotent',
        firstResult: actualOutcome,
        secondResult: secondRollback,
      });
    }

    // Verify no side effects remain
    // (This would be operation-specific validation)
  } catch (error) {
    passed = false;
    errors.push({
      type: 'rollback_failure',
      message: error.message,
      stack: error.stack,
    });
  }

  const duration = Date.now() - startTime;

  const testRecord = await recordRecoveryTest({
    testId,
    operationType,
    interruptionPoint,
    snapshot,
    recoveryFunction: 'rollback',
    expectedOutcome: expectedRollbackState,
    actualOutcome,
    passed,
    duration,
    errors,
    metadata: { testType: 'rollback' },
  });

  logger.info(
    {
      testId,
      operationType,
      interruptionPoint,
      passed,
      duration,
    },
    '[RecoveryTests] Completed rollback test'
  );

  return testRecord;
}

/**
 * Get recovery test history for an operation type
 */
export async function getRecoveryTestHistory({
  operationType = null,
  interruptionPoint = null,
  status = null,
  limit = 100,
}) {
  const db = await getDb();
  const collection = db.collection('recovery_tests');

  const query = {};
  if (operationType) query.operationType = operationType;
  if (interruptionPoint) query.interruptionPoint = interruptionPoint;
  if (status) query.status = status;

  const tests = await collection
    .find(query)
    .sort({ testedAt: -1 })
    .limit(limit)
    .toArray();

  return tests;
}

/**
 * Generate recovery test report
 */
export async function generateRecoveryTestReport({
  operationType = null,
  since = null,
}) {
  const db = await getDb();
  const collection = db.collection('recovery_tests');

  const query = {};
  if (operationType) query.operationType = operationType;
  if (since) query.testedAt = { $gte: new Date(since) };

  const tests = await collection.find(query).toArray();

  const report = {
    reportType: 'recovery_tests',
    generatedAt: new Date(),
    totalTests: tests.length,
    byStatus: {},
    byOperationType: {},
    byInterruptionPoint: {},
    averageDuration: 0,
    failureRate: 0,
  };

  let totalDuration = 0;
  let failedCount = 0;

  for (const test of tests) {
    // By status
    if (!report.byStatus[test.status]) {
      report.byStatus[test.status] = 0;
    }
    report.byStatus[test.status]++;

    // By operation type
    if (!report.byOperationType[test.operationType]) {
      report.byOperationType[test.operationType] = {
        total: 0,
        passed: 0,
        failed: 0,
      };
    }
    report.byOperationType[test.operationType].total++;
    if (test.status === RecoveryTestStatus.PASSED) {
      report.byOperationType[test.operationType].passed++;
    } else if (test.status === RecoveryTestStatus.FAILED) {
      report.byOperationType[test.operationType].failed++;
      failedCount++;
    }

    // By interruption point
    if (!report.byInterruptionPoint[test.interruptionPoint]) {
      report.byInterruptionPoint[test.interruptionPoint] = {
        total: 0,
        passed: 0,
        failed: 0,
      };
    }
    report.byInterruptionPoint[test.interruptionPoint].total++;
    if (test.status === RecoveryTestStatus.PASSED) {
      report.byInterruptionPoint[test.interruptionPoint].passed++;
    } else if (test.status === RecoveryTestStatus.FAILED) {
      report.byInterruptionPoint[test.interruptionPoint].failed++;
    }

    totalDuration += test.duration || 0;
  }

  report.averageDuration = tests.length > 0 ? totalDuration / tests.length : 0;
  report.failureRate = tests.length > 0 ? (failedCount / tests.length) * 100 : 0;

  return report;
}

export default {
  createStateSnapshot,
  recordRecoveryTest,
  testRecoveryFromInterruption,
  runRecoveryTestSuite,
  testRollbackFromInterruption,
  getRecoveryTestHistory,
  generateRecoveryTestReport,
  InterruptionPoint,
  RecoveryTestStatus,
};

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FeatureRolloutGuard,
  ROLLOUT_STATUS,
  computePrincipalBucket,
} from '../../src/lib/featureFlags/rolloutGuard.js';

test('computePrincipalBucket is deterministic and uniformly bounded in 0..99', () => {
  const bucket1 = computePrincipalBucket('NEW_CHECKOUT_FLOW', 'GBUYER123456');
  const bucket2 = computePrincipalBucket('NEW_CHECKOUT_FLOW', 'GBUYER123456');
  const bucket3 = computePrincipalBucket('NEW_CHECKOUT_FLOW', 'gbuyer123456'); // case-insensitive

  assert.equal(bucket1, bucket2);
  assert.equal(bucket1, bucket3);
  assert.ok(bucket1 >= 0 && bucket1 < 100);

  // Different user gets another bucket
  const buckets = new Set();
  for (let i = 0; i < 20; i++) {
    buckets.add(computePrincipalBucket('NEW_CHECKOUT_FLOW', `GBUYER_${i}`));
  }
  assert.ok(buckets.size > 5, 'Buckets should distribute across distinct values');
});

test('FeatureRolloutGuard honors whitelist and rollout percentages', () => {
  const guard = new FeatureRolloutGuard({
    flagKey: 'INSTANT_PAYOUTS',
    rolloutPercentage: 0,
    whitelist: ['g_vip_creator'],
  });

  // Whitelisted creator is enrolled even at 0% rollout
  assert.equal(guard.isEnrolled('G_VIP_CREATOR'), true);
  // Normal creator is not enrolled
  assert.equal(guard.isEnrolled('G_REGULAR_CREATOR'), false);

  // At 100% rollout, all principals are enrolled
  const guardFull = new FeatureRolloutGuard({
    flagKey: 'INSTANT_PAYOUTS',
    rolloutPercentage: 100,
  });
  assert.equal(guardFull.isEnrolled('G_REGULAR_CREATOR'), true);
});

test('FeatureRolloutGuard executes riskyOperation when healthy', async () => {
  const guard = new FeatureRolloutGuard({
    flagKey: 'FAST_DOWNLOADS',
    rolloutPercentage: 100,
  });

  let riskyCalled = false;
  let fallbackCalled = false;

  const result = await guard.execute({
    principalId: 'user_1',
    riskyOperation: async () => {
      riskyCalled = true;
      return { success: true, engine: 'v2-accelerated' };
    },
    fallbackOperation: async () => {
      fallbackCalled = true;
      return { success: true, engine: 'v1-standard' };
    },
  });

  assert.equal(riskyCalled, true);
  assert.equal(fallbackCalled, false);
  assert.equal(result.engine, 'v2-accelerated');
  assert.equal(guard.status, ROLLOUT_STATUS.ROLLING_OUT);
  assert.equal(guard.consecutiveFailures, 0);
});

test('FeatureRolloutGuard triggers automatic rollback on consecutive errors and executes post-rollback verification', async () => {
  const guard = new FeatureRolloutGuard({
    flagKey: 'NEW_PAYOUT_ENGINE',
    rolloutPercentage: 100,
    maxConsecutiveFailures: 3,
  });

  let activeReservations = 2;
  const mockDb = {
    collection() {
      return {
        async findOne() { return null; },
        async insertOne() { return { acknowledged: true }; },
        find() {
          return {
            sort() {
              return {
                limit() {
                  return {
                    async toArray() { return []; },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  const riskyFailingOp = async () => {
    throw new Error('Soroban contract simulation out-of-gas');
  };

  const safeFallbackOp = async () => {
    return { success: true, mode: 'legacy-safe' };
  };

  const cleanupHandler = async () => {
    // Release in-flight reservations
    activeReservations = 0;
    return { cleaned: true, releasedReservations: 2 };
  };

  const consistencyVerifier = async () => {
    // Verify 0 orphaned reservations
    return { verified: true, orphanedRecordsCount: activeReservations };
  };

  // 1st failure: falls back to safe op
  const res1 = await guard.execute({
    principalId: 'user_a',
    riskyOperation: riskyFailingOp,
    fallbackOperation: safeFallbackOp,
    rollbackCleanup: cleanupHandler,
    verifyConsistency: consistencyVerifier,
    db: mockDb,
  });
  assert.equal(res1.mode, 'legacy-safe');
  assert.equal(guard.status, ROLLOUT_STATUS.ROLLING_OUT);
  assert.equal(guard.consecutiveFailures, 1);

  // 2nd failure
  await guard.execute({
    principalId: 'user_b',
    riskyOperation: riskyFailingOp,
    fallbackOperation: safeFallbackOp,
    rollbackCleanup: cleanupHandler,
    verifyConsistency: consistencyVerifier,
    db: mockDb,
  });
  assert.equal(guard.consecutiveFailures, 2);

  // 3rd failure: reaches maxConsecutiveFailures -> AUTOMATIC ROLLBACK TRIGGERED!
  await guard.execute({
    principalId: 'user_c',
    riskyOperation: riskyFailingOp,
    fallbackOperation: safeFallbackOp,
    rollbackCleanup: cleanupHandler,
    verifyConsistency: consistencyVerifier,
    db: mockDb,
  });

  assert.equal(guard.status, ROLLOUT_STATUS.ROLLED_BACK);
  assert.ok(guard.rollbackReason.includes('out-of-gas'));
  assert.ok(guard.rolledBackAt);

  // Verify post-rollback integrity report
  const postVerification = guard.postRollbackVerification;
  assert.ok(postVerification, 'Must have post-rollback verification report');
  assert.equal(postVerification.verifiedClean, true);
  assert.equal(postVerification.cleanup.releasedReservations, 2);
  assert.equal(postVerification.consistency.orphanedRecordsCount, 0);

  // Subsequent call automatically bypasses risky op without running it
  let riskyAttemptedAfterRollback = false;
  const res4 = await guard.execute({
    principalId: 'user_d',
    riskyOperation: async () => {
      riskyAttemptedAfterRollback = true;
      return { success: false };
    },
    fallbackOperation: safeFallbackOp,
  });

  assert.equal(riskyAttemptedAfterRollback, false);
  assert.equal(res4.mode, 'legacy-safe');
});

test('FeatureRolloutGuard triggers automatic rollback on invariant check failure', async () => {
  const guard = new FeatureRolloutGuard({
    flagKey: 'ENTITLEMENT_SNAPSHOT_V2',
    rolloutPercentage: 100,
  });

  const corruptResultOp = async () => {
    return { entitlementId: 'ent-1', grantedAccess: true, balanceDeducted: -50 }; // Negative balance violated invariant
  };

  const invariantCheck = async (result) => {
    if (result.balanceDeducted < 0) {
      return { valid: false, reason: 'Balance deduction cannot be negative' };
    }
    return { valid: true };
  };

  const fallbackOp = async () => {
    return { entitlementId: 'ent-1', grantedAccess: true, balanceDeducted: 0, fallback: true };
  };

  const result = await guard.execute({
    principalId: 'user_x',
    riskyOperation: corruptResultOp,
    fallbackOperation: fallbackOp,
    invariantCheck,
    rollbackCleanup: async () => ({ cleaned: true }),
    verifyConsistency: async () => ({ verified: true, orphanedRecordsCount: 0 }),
  });

  assert.equal(result.fallback, true);
  assert.equal(guard.status, ROLLOUT_STATUS.ROLLED_BACK);
  assert.ok(guard.rollbackReason.includes('Balance deduction cannot be negative'));
  assert.equal(guard.postRollbackVerification.verifiedClean, true);
});

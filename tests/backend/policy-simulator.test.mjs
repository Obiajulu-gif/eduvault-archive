/**
 * Automated tests for Policy Simulation Preview Engine — Issue #975
 *
 * Verifies:
 *   - Preview of affected records/users, expected side effects, and rollback constraints
 *   - Accurate impact projection across all policy types (fees, entitlements, payouts, quarantine, retention)
 *   - Detection of irreversible operations and enforcement of confirmation flags
 *   - Two-person dual approval enforcement for high/critical severity changes
 *   - Time-of-Check to Time-of-Use (TOCTOU) protection via simulationFingerprint
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  POLICY_TYPES,
  IMPACT_SEVERITY,
  simulatePolicyChange,
  assertPolicyCommitAllowed,
  PolicySimulationError,
} from '../../src/lib/policies/policySimulator.js';

const SAMPLE_DATA = {
  materials: [
    { _id: 'mat_1', materialId: 'mat_1', title: 'Intro to Soroban', subject: 'blockchain', userAddress: 'GCREATOR1' },
    { _id: 'mat_2', materialId: 'mat_2', title: 'Advanced Rust', subject: 'programming', userAddress: 'GCREATOR1' },
    { _id: 'mat_3', materialId: 'mat_3', title: 'DeFi Mechanics', subject: 'blockchain', userAddress: 'GCREATOR2' },
  ],
  purchases: [
    { _id: 'p_1', purchaseId: 'p_1', materialId: 'mat_1', amount: 100, creator: 'GCREATOR1', learnerId: 'learner_1' },
    { _id: 'p_2', purchaseId: 'p_2', materialId: 'mat_1', amount: 100, creator: 'GCREATOR1', learnerId: 'learner_2' },
    { _id: 'p_3', purchaseId: 'p_3', materialId: 'mat_2', amount: 250, creator: 'GCREATOR1', learnerId: 'learner_3' },
    { _id: 'p_4', purchaseId: 'p_4', materialId: 'mat_3', amount: 500, creator: 'GCREATOR2', learnerId: 'learner_1' },
  ],
  payouts: [
    { _id: 'pay_1', payoutId: 'pay_1', creator: 'GCREATOR1', amount: 800, status: 'pending' },
    { _id: 'pay_2', payoutId: 'pay_2', creator: 'GCREATOR2', amount: 2500, status: 'pending' },
    { _id: 'pay_3', payoutId: 'pay_3', creator: 'GCREATOR3', amount: 150, status: 'pending' },
  ],
  exportRecords: [
    { _id: 'exp_1', exportId: 'exp_1', userId: 'learner_1', sizeBytes: 5 * 1024 * 1024, createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString() }, // 100 days old
    { _id: 'exp_2', exportId: 'exp_2', userId: 'learner_2', sizeBytes: 20 * 1024 * 1024, createdAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString() }, // 120 days old
    { _id: 'exp_3', exportId: 'exp_3', userId: 'learner_3', sizeBytes: 2 * 1024 * 1024, createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() }, // 10 days old
  ],
};

describe('Policy Simulator — Marketplace Fee Changes (#975)', () => {
  test('projects financial volume, fee delta, and affected creators', async () => {
    const preview = await simulatePolicyChange({
      policyType: POLICY_TYPES.MARKETPLACE_FEE,
      currentPolicy: { platformFeeBps: 500 }, // 5%
      proposedPolicy: { platformFeeBps: 1000 }, // 10% (+500 bps)
      dataSource: SAMPLE_DATA,
      actor: { walletAddress: 'GADMIN1' },
    });

    assert.equal(preview.status, 'preview_ready');
    assert.equal(preview.policyType, POLICY_TYPES.MARKETPLACE_FEE);
    assert.equal(preview.parameters.delta.feeDeltaBps, 500);

    // Total volume in sample: 100 + 100 + 250 + 500 = 950 XLM
    const fin = preview.impactAssessment.financialImpact;
    assert.equal(fin.volumeAffected, 950);
    // 5% increase on 950 XLM = +47.5 XLM platform fee, -47.5 XLM creator net
    assert.equal(fin.platformFeeDelta, 47.5);
    assert.equal(fin.creatorNetDelta, -47.5);

    assert.equal(preview.impactAssessment.affectedUsersCount, 2); // GCREATOR1 and GCREATOR2
    assert.equal(preview.rollbackConstraints.isFullyReversible, true);
    assert.ok(preview.rollbackConstraints.rollbackPlaybookSteps.length > 0);
    assert.ok(preview.simulationFingerprint);
  });

  test('flags high financial impact as requiring confirmation', async () => {
    const preview = await simulatePolicyChange({
      policyType: POLICY_TYPES.MARKETPLACE_FEE,
      currentPolicy: { platformFeeBps: 500 },
      proposedPolicy: { platformFeeBps: 1800 }, // +1300 bps (critical severity)
      dataSource: SAMPLE_DATA,
      actor: { walletAddress: 'GADMIN1' },
    });

    assert.equal(preview.impactAssessment.severity, IMPACT_SEVERITY.CRITICAL);
    assert.equal(preview.rollbackConstraints.preconditionsRequired.confirmFinancialImpact, true);
    assert.equal(preview.rollbackConstraints.preconditionsRequired.twoPersonApprovalRequired, true);
  });
});

describe('Policy Simulator — Entitlement Revocation (#975)', () => {
  test('identifies affected learners and flags irreversible cryptographic token revocation', async () => {
    const preview = await simulatePolicyChange({
      policyType: POLICY_TYPES.ENTITLEMENT_REVOCATION,
      proposedPolicy: { materialIds: ['mat_1'], reason: 'Copyright challenge' },
      dataSource: SAMPLE_DATA,
      actor: { walletAddress: 'GADMIN1' },
    });

    // mat_1 was purchased by learner_1 and learner_2
    assert.equal(preview.impactAssessment.affectedUsersCount, 2);
    assert.equal(preview.rollbackConstraints.isFullyReversible, false);
    assert.equal(preview.rollbackConstraints.hasIrreversibleOperations, true);
    assert.ok(preview.rollbackConstraints.irreversibleOperations.some((op) => op.includes('cryptographic capability tokens')));
    assert.equal(preview.rollbackConstraints.preconditionsRequired.confirmIrreversibleRevocation, true);

    const sideEffects = preview.expectedSideEffects;
    assert.ok(sideEffects.some((se) => se.category === 'ACCESS' && se.severity === 'CRITICAL'));
    assert.ok(sideEffects.some((se) => se.category === 'USER_EXPERIENCE' && se.description.includes('403')));
  });
});

describe('Policy Simulator — Creator Payout Caps (#975)', () => {
  test('identifies pending payout requests exceeding proposed cap and projects delay', async () => {
    const preview = await simulatePolicyChange({
      policyType: POLICY_TYPES.CREATOR_PAYOUT_CAP,
      currentPolicy: { maxPayoutPerTx: 5000 },
      proposedPolicy: { maxPayoutPerTx: 1000 }, // Proposed cap 1000 XLM
      dataSource: SAMPLE_DATA,
      actor: { walletAddress: 'GADMIN1' },
    });

    // Payout pay_2 has amount 2500, which exceeds 1000
    assert.equal(preview.impactAssessment.affectedRecordsCount, 1);
    assert.equal(preview.impactAssessment.financialImpact.volumeAffected, 2500);
    assert.equal(preview.rollbackConstraints.preconditionsRequired.confirmPendingPayoutDelay, true);
    assert.ok(preview.expectedSideEffects.some((se) => se.description.includes('exceed the proposed cap')));
  });
});

describe('Policy Simulator — Content Quarantine (#975)', () => {
  test('matches materials by criteria and evaluates search and buyer impacts', async () => {
    const preview = await simulatePolicyChange({
      policyType: POLICY_TYPES.CONTENT_QUARANTINE,
      proposedPolicy: { criteria: { subject: 'blockchain' } },
      dataSource: SAMPLE_DATA,
      actor: { walletAddress: 'GADMIN1' },
    });

    // mat_1 and mat_3 have subject 'blockchain'
    assert.equal(preview.impactAssessment.affectedRecordsCount, 2);
    assert.equal(preview.rollbackConstraints.isFullyReversible, true);
    assert.ok(preview.expectedSideEffects.some((se) => se.category === 'SEARCH'));
  });
});

describe('Policy Simulator — Archive Retention & Permanent Purge (#975)', () => {
  test('flags irreversible data loss for permanent storage deletions', async () => {
    const preview = await simulatePolicyChange({
      policyType: POLICY_TYPES.ARCHIVE_RETENTION,
      proposedPolicy: { retainExportsDays: 90 }, // Exports older than 90 days
      dataSource: SAMPLE_DATA,
      actor: { walletAddress: 'GADMIN1' },
    });

    // exp_1 (100 days) and exp_2 (120 days) are older than 90 days
    assert.equal(preview.impactAssessment.affectedRecordsCount, 2);
    // Bytes: 5MB + 20MB = 25MB
    assert.equal(preview.parameters.delta.totalBytesToPurge, 25 * 1024 * 1024);
    assert.equal(preview.rollbackConstraints.isFullyReversible, false);
    assert.equal(preview.rollbackConstraints.hasIrreversibleOperations, true);
    assert.equal(preview.rollbackConstraints.preconditionsRequired.confirmIrreversibleDataLoss, true);
    assert.equal(preview.rollbackConstraints.preconditionsRequired.twoPersonApprovalRequired, true);

    assert.ok(preview.expectedSideEffects.some((se) => se.category === 'STORAGE' && se.severity === 'CRITICAL'));
  });
});

describe('Policy Simulator — Commit Gatekeeper (#975)', () => {
  test('rejects commit if simulation preview is expired', async () => {
    const preview = await simulatePolicyChange({
      policyType: POLICY_TYPES.MARKETPLACE_FEE,
      proposedPolicy: { platformFeeBps: 600 },
      dataSource: SAMPLE_DATA,
      actor: { walletAddress: 'GADMIN1' },
    });

    // Manipulate expiration to the past
    preview.expiresAt = new Date(Date.now() - 1000).toISOString();

    assert.throws(
      () =>
        assertPolicyCommitAllowed(preview, {
          simulationFingerprint: preview.simulationFingerprint,
        }),
      (err) => err instanceof PolicySimulationError && err.code === 'SIMULATION_EXPIRED'
    );
  });

  test('rejects commit on fingerprint mismatch (TOCTOU protection)', async () => {
    const preview = await simulatePolicyChange({
      policyType: POLICY_TYPES.MARKETPLACE_FEE,
      proposedPolicy: { platformFeeBps: 600 },
      dataSource: SAMPLE_DATA,
      actor: { walletAddress: 'GADMIN1' },
    });

    assert.throws(
      () =>
        assertPolicyCommitAllowed(preview, {
          simulationFingerprint: 'tampered_or_stale_fingerprint',
        }),
      (err) => err instanceof PolicySimulationError && err.code === 'FINGERPRINT_MISMATCH'
    );
  });

  test('blocks irreversible data loss without confirmIrreversibleDataLoss flag', async () => {
    const preview = await simulatePolicyChange({
      policyType: POLICY_TYPES.ARCHIVE_RETENTION,
      proposedPolicy: { retainExportsDays: 30 },
      dataSource: SAMPLE_DATA,
      actor: { walletAddress: 'GADMIN1' },
    });

    assert.throws(
      () =>
        assertPolicyCommitAllowed(preview, {
          simulationFingerprint: preview.simulationFingerprint,
          // Missing confirmIrreversibleDataLoss
        }),
      (err) =>
        err instanceof PolicySimulationError &&
        err.code === 'CONFIRMATION_REQUIRED' &&
        err.details.requiredFlag === 'confirmIrreversibleDataLoss'
    );
  });

  test('blocks two-person rule violation if secondary approver is the same maintainer', async () => {
    const preview = await simulatePolicyChange({
      policyType: POLICY_TYPES.ARCHIVE_RETENTION,
      proposedPolicy: { retainExportsDays: 30 },
      dataSource: SAMPLE_DATA,
      actor: { walletAddress: 'GADMIN1' },
    });

    assert.throws(
      () =>
        assertPolicyCommitAllowed(preview, {
          simulationFingerprint: preview.simulationFingerprint,
          confirmIrreversibleDataLoss: true,
          secondaryApprover: 'GADMIN1', // Same maintainer!
        }),
      (err) => err instanceof PolicySimulationError && err.code === 'SELF_APPROVAL_FORBIDDEN'
    );
  });

  test('authorizes commit when all preconditions, dual approvals, and fingerprints match', async () => {
    const preview = await simulatePolicyChange({
      policyType: POLICY_TYPES.ARCHIVE_RETENTION,
      proposedPolicy: { retainExportsDays: 30 },
      dataSource: SAMPLE_DATA,
      actor: { walletAddress: 'GADMIN1' },
    });

    const isAllowed = assertPolicyCommitAllowed(preview, {
      simulationFingerprint: preview.simulationFingerprint,
      confirmIrreversibleDataLoss: true,
      secondaryApprover: 'GADMIN2_DIFFERENT',
    });

    assert.equal(isAllowed, true);
  });
});

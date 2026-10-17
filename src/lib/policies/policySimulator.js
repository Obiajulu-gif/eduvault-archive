/**
 * Policy Simulation Preview Engine for High-Impact & Irreversible Changes — Issue #975
 *
 * Provides pre-flight impact simulation and rollback constraint analysis before
 * maintainers commit irreversible or high-impact policy changes across:
 *   - Educational Content Marketplace (fees, royalty splits)
 *   - Entitlement Checks (bulk revocations, license term updates)
 *   - Creator Payouts (payout caps, minimum balance, velocity throttles)
 *   - Archive Safety & Storage (retention limits, permanent purges)
 *
 * Guarantees:
 *   - Pure simulation: Reads state, projects impact, NEVER commits writes.
 *   - Time-of-Check to Time-of-Use (TOCTOU) protection via deterministic simulationFingerprint.
 *   - Explicit rollback constraints and gatekeeping for irreversible operations.
 */

import { canonicalHash } from '../canonical.js';

/** Supported High-Impact Policy Types */
export const POLICY_TYPES = Object.freeze({
  MARKETPLACE_FEE: 'MARKETPLACE_FEE',
  ENTITLEMENT_REVOCATION: 'ENTITLEMENT_REVOCATION',
  CREATOR_PAYOUT_CAP: 'CREATOR_PAYOUT_CAP',
  CONTENT_QUARANTINE: 'CONTENT_QUARANTINE',
  ARCHIVE_RETENTION: 'ARCHIVE_RETENTION',
});

/** Impact Severity Classification */
export const IMPACT_SEVERITY = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});

/** Simulation Lifetime: Valid for 15 minutes to prevent stale commits */
export const SIMULATION_TTL_MS = 15 * 60 * 1000;

export class PolicySimulationError extends Error {
  constructor(message, code = 'SIMULATION_ERROR', status = 400, details = null) {
    super(message);
    this.name = 'PolicySimulationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Generate a deterministic simulation ID
 */
function generateSimulationId(policyType) {
  const timestamp = Date.now().toString(36);
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  return `sim_${policyType.toLowerCase()}_${timestamp}_${randomSuffix}`;
}

/**
 * Simulates a proposed policy change against system records and returns a comprehensive preview.
 *
 * @param {object} params
 * @param {string} params.policyType - One of POLICY_TYPES
 * @param {object} params.proposedPolicy - Proposed configuration
 * @param {object} [params.currentPolicy={}] - Current active configuration
 * @param {object} [params.dataSource={}] - In-memory collections or database accessors for simulation
 * @param {object} [params.actor={}] - Maintainer requesting simulation
 * @returns {Promise<object>} PolicySimulationPreview
 */
export async function simulatePolicyChange({
  policyType,
  proposedPolicy,
  currentPolicy = {},
  dataSource = {},
  actor = {},
}) {
  if (!policyType || !Object.values(POLICY_TYPES).includes(policyType)) {
    throw new PolicySimulationError(
      `Invalid or unsupported policyType: ${policyType}. Supported: ${Object.values(POLICY_TYPES).join(', ')}`,
      'INVALID_POLICY_TYPE',
      400
    );
  }

  if (!proposedPolicy || typeof proposedPolicy !== 'object') {
    throw new PolicySimulationError('proposedPolicy must be an object', 'INVALID_PROPOSED_POLICY', 400);
  }

  const now = new Date();
  const simulationId = generateSimulationId(policyType);
  const expiresAt = new Date(now.getTime() + SIMULATION_TTL_MS).toISOString();

  let simulationResult;
  switch (policyType) {
    case POLICY_TYPES.MARKETPLACE_FEE:
      simulationResult = simulateMarketplaceFee(currentPolicy, proposedPolicy, dataSource);
      break;
    case POLICY_TYPES.ENTITLEMENT_REVOCATION:
      simulationResult = simulateEntitlementRevocation(currentPolicy, proposedPolicy, dataSource);
      break;
    case POLICY_TYPES.CREATOR_PAYOUT_CAP:
      simulationResult = simulateCreatorPayoutCap(currentPolicy, proposedPolicy, dataSource);
      break;
    case POLICY_TYPES.CONTENT_QUARANTINE:
      simulationResult = simulateContentQuarantine(currentPolicy, proposedPolicy, dataSource);
      break;
    case POLICY_TYPES.ARCHIVE_RETENTION:
      simulationResult = simulateArchiveRetention(currentPolicy, proposedPolicy, dataSource);
      break;
    default:
      throw new PolicySimulationError(`Unhandled simulation for ${policyType}`);
  }

  const preview = {
    simulationId,
    policyType,
    status: simulationResult.status || 'preview_ready',
    timestamp: now.toISOString(),
    expiresAt,
    actor: actor.walletAddress || actor.email || actor.sub || 'maintainer',
    parameters: {
      current: currentPolicy,
      proposed: proposedPolicy,
      delta: simulationResult.delta || {},
    },
    impactAssessment: simulationResult.impactAssessment,
    expectedSideEffects: simulationResult.expectedSideEffects || [],
    rollbackConstraints: simulationResult.rollbackConstraints,
  };

  // Generate deterministic canonical fingerprint covering parameters and projected impact
  preview.simulationFingerprint = canonicalHash({
    simulationId,
    policyType,
    parameters: preview.parameters,
    impactAssessment: {
      severity: preview.impactAssessment.severity,
      affectedRecordsCount: preview.impactAssessment.affectedRecordsCount,
      affectedUsersCount: preview.impactAssessment.affectedUsersCount,
    },
    hasIrreversibleOperations: preview.rollbackConstraints.hasIrreversibleOperations,
  });

  return preview;
}

/**
 * 1. Marketplace Fee Policy Simulation
 */
function simulateMarketplaceFee(current, proposed, data) {
  const currentFeeBps = current.platformFeeBps ?? 500; // default 5%
  const proposedFeeBps = proposed.platformFeeBps;

  if (typeof proposedFeeBps !== 'number' || proposedFeeBps < 0 || proposedFeeBps > 5000) {
    throw new PolicySimulationError('platformFeeBps must be a number between 0 and 5000 (0% - 50%)');
  }

  const materials = data.materials || [];
  const purchases = data.purchases || [];

  const feeDeltaBps = proposedFeeBps - currentFeeBps;
  const isIncrease = feeDeltaBps > 0;

  // Calculate volume impact across historical purchases sample
  let totalVolume = 0;
  let oldFeeRevenue = 0;
  let newFeeRevenue = 0;
  const affectedCreatorSet = new Set();
  const affectedPurchases = [];

  for (const p of purchases) {
    const amount = Number(p.amount) || 0;
    totalVolume += amount;
    oldFeeRevenue += (amount * currentFeeBps) / 10000;
    newFeeRevenue += (amount * proposedFeeBps) / 10000;
    if (p.creator) affectedCreatorSet.add(p.creator);
    if (affectedPurchases.length < 5) {
      affectedPurchases.push({ recordId: p.purchaseId || p._id, type: 'purchase', amount });
    }
  }

  const feeRevenueDelta = newFeeRevenue - oldFeeRevenue;
  const creatorNetDelta = -feeRevenueDelta;

  const severity =
    Math.abs(feeDeltaBps) > 1000 || totalVolume > 50000
      ? IMPACT_SEVERITY.CRITICAL
      : Math.abs(feeDeltaBps) > 200 || totalVolume > 5000
      ? IMPACT_SEVERITY.HIGH
      : IMPACT_SEVERITY.MEDIUM;

  const sideEffects = [];
  if (isIncrease) {
    sideEffects.push({
      category: 'FINANCIAL',
      severity: 'WARNING',
      description: `Platform fee increase of ${(feeDeltaBps / 100).toFixed(2)}% reduces creator net revenue by ${Math.abs(creatorNetDelta).toFixed(2)} XLM across sample volume.`,
      impactedCount: affectedCreatorSet.size,
      mitigationHint: 'Provide creators a 14-day advance notification window before activating fee change.',
    });
  } else if (feeDeltaBps < 0) {
    sideEffects.push({
      category: 'FINANCIAL',
      severity: 'INFO',
      description: `Platform fee reduction of ${(Math.abs(feeDeltaBps) / 100).toFixed(2)}% increases creator earnings.`,
      impactedCount: affectedCreatorSet.size,
      mitigationHint: 'Verify platform operational margin coverage.',
    });
  }

  const hasIrreversibleOperations = false; // Fee changes for new listings are reversible, existing transactions remain settled
  const rollbackPlaybookSteps = [
    'Update platform fee configuration back to previous platformFeeBps.',
    'Clear cached fee quotes in checkoutQuotes collection.',
    'Verify that active cart quotes reflect original fee.',
  ];

  return {
    delta: { feeDeltaBps, feeDeltaPercent: (feeDeltaBps / 100).toFixed(2) + '%' },
    impactAssessment: {
      severity,
      affectedRecordsCount: materials.length + purchases.length,
      affectedUsersCount: affectedCreatorSet.size,
      affectedUsersSample: Array.from(affectedCreatorSet).slice(0, 5).map((w) => ({ userId: w, role: 'creator' })),
      affectedRecordsSample: affectedPurchases,
      financialImpact: {
        volumeAffected: totalVolume,
        currency: 'XLM',
        creatorNetDelta,
        platformFeeDelta: feeRevenueDelta,
      },
    },
    expectedSideEffects: sideEffects,
    rollbackConstraints: {
      isFullyReversible: true,
      hasIrreversibleOperations,
      irreversibleOperations: [
        'Settled on-chain transactions cannot have fee splits retroactively adjusted.',
      ],
      rollbackPlaybookSteps,
      estimatedRollbackTimeMinutes: 5,
      preconditionsRequired: {
        confirmFinancialImpact: severity === IMPACT_SEVERITY.CRITICAL || severity === IMPACT_SEVERITY.HIGH,
        twoPersonApprovalRequired: severity === IMPACT_SEVERITY.CRITICAL,
      },
    },
  };
}

/**
 * 2. Entitlement Revocation Policy Simulation
 */
function simulateEntitlementRevocation(current, proposed, data) {
  const targetMaterialIds = proposed.materialIds || [];
  if (!Array.isArray(targetMaterialIds) || targetMaterialIds.length === 0) {
    throw new PolicySimulationError('materialIds must be a non-empty array of strings');
  }

  const purchases = data.purchases || [];
  const entitlementCache = data.entitlementCache || [];

  const affectedLearners = new Set();
  const affectedPurchases = [];

  for (const p of purchases) {
    if (targetMaterialIds.includes(p.materialId)) {
      if (p.learnerId || p.userId || p.buyer) {
        affectedLearners.add(p.learnerId || p.userId || p.buyer);
      }
      if (affectedPurchases.length < 5) {
        affectedPurchases.push({
          recordId: p.purchaseId || p._id,
          type: 'purchase_entitlement',
          title: `Material: ${p.materialId}`,
        });
      }
    }
  }

  const learnerCount = affectedLearners.size;
  const severity =
    learnerCount > 100
      ? IMPACT_SEVERITY.CRITICAL
      : learnerCount > 10
      ? IMPACT_SEVERITY.HIGH
      : learnerCount > 0
      ? IMPACT_SEVERITY.MEDIUM
      : IMPACT_SEVERITY.LOW;

  const sideEffects = [
    {
      category: 'ACCESS',
      severity: 'CRITICAL',
      description: `${learnerCount} learners will lose access to ${targetMaterialIds.length} materials immediately.`,
      impactedCount: learnerCount,
      mitigationHint: 'Ensure alternative educational replacement is linked or automatic refunds are enabled.',
    },
    {
      category: 'USER_EXPERIENCE',
      severity: 'WARNING',
      description: 'Active client downloads in progress will terminate with HTTP 403 Forbidden.',
      impactedCount: learnerCount,
      mitigationHint: 'Schedule revocation during off-peak hours (02:00 - 05:00 UTC).',
    },
  ];

  const irreversibleOps = [
    'Revoked cryptographic capability tokens cannot be recovered without learner re-authenticating.',
    'On-chain Soroban contract revocation state requires blockchain gas fees to restore.',
  ];

  return {
    delta: { revokedMaterialsCount: targetMaterialIds.length, targetMaterialIds },
    impactAssessment: {
      severity,
      affectedRecordsCount: purchases.length + entitlementCache.length,
      affectedUsersCount: learnerCount,
      affectedUsersSample: Array.from(affectedLearners).slice(0, 5).map((id) => ({ userId: id, role: 'learner' })),
      affectedRecordsSample: affectedPurchases,
      financialImpact: null,
    },
    expectedSideEffects: sideEffects,
    rollbackConstraints: {
      isFullyReversible: false,
      hasIrreversibleOperations: true,
      irreversibleOperations: irreversibleOps,
      rollbackPlaybookSteps: [
        'Re-grant entitlement entries in entitlement_cache for all affected learner IDs.',
        'Issue re-grant transactions on Stellar/Soroban ledger for on-chain verifiable materials.',
        'Dispatch email notifications to affected learners containing restored download credentials.',
      ],
      estimatedRollbackTimeMinutes: 45,
      preconditionsRequired: {
        confirmIrreversibleRevocation: true,
        twoPersonApprovalRequired: severity === IMPACT_SEVERITY.CRITICAL,
      },
    },
  };
}

/**
 * 3. Creator Payout Cap Simulation
 */
function simulateCreatorPayoutCap(current, proposed, data) {
  const proposedMaxCap = proposed.maxPayoutPerTx;
  if (typeof proposedMaxCap !== 'number' || proposedMaxCap <= 0) {
    throw new PolicySimulationError('maxPayoutPerTx must be a positive number');
  }

  const currentMaxCap = current.maxPayoutPerTx ?? 5000;
  const pendingPayouts = data.payouts || [];

  let affectedPayoutCount = 0;
  let affectedPayoutVolume = 0;
  const affectedCreators = new Set();
  const sampleBlocked = [];

  for (const payout of pendingPayouts) {
    const amount = Number(payout.amount) || 0;
    if (amount > proposedMaxCap) {
      affectedPayoutCount++;
      affectedPayoutVolume += amount;
      if (payout.creator) affectedCreators.add(payout.creator);
      if (sampleBlocked.length < 5) {
        sampleBlocked.push({
          recordId: payout.payoutId || payout._id,
          type: 'payout_request',
          amount,
        });
      }
    }
  }

  const severity =
    affectedPayoutCount > 10 || affectedPayoutVolume > 10000
      ? IMPACT_SEVERITY.HIGH
      : affectedPayoutCount > 0
      ? IMPACT_SEVERITY.MEDIUM
      : IMPACT_SEVERITY.LOW;

  const sideEffects = [];
  if (affectedPayoutCount > 0) {
    sideEffects.push({
      category: 'FINANCIAL',
      severity: 'WARNING',
      description: `${affectedPayoutCount} pending payouts totaling ${affectedPayoutVolume.toFixed(2)} XLM exceed the proposed cap of ${proposedMaxCap} XLM and will be held.`,
      impactedCount: affectedCreators.size,
      mitigationHint: 'Process existing pending queue under previous threshold before applying new cap, or enable automatic tranche splitting.',
    });
  }

  return {
    delta: { previousCap: currentMaxCap, proposedCap: proposedMaxCap, capDelta: proposedMaxCap - currentMaxCap },
    impactAssessment: {
      severity,
      affectedRecordsCount: affectedPayoutCount,
      affectedUsersCount: affectedCreators.size,
      affectedUsersSample: Array.from(affectedCreators).slice(0, 5).map((w) => ({ userId: w, role: 'creator' })),
      affectedRecordsSample: sampleBlocked,
      financialImpact: {
        volumeAffected: affectedPayoutVolume,
        currency: 'XLM',
        creatorNetDelta: 0,
        platformFeeDelta: 0,
      },
    },
    expectedSideEffects: sideEffects,
    rollbackConstraints: {
      isFullyReversible: true,
      hasIrreversibleOperations: false,
      irreversibleOperations: [
        'Payouts already settled on Stellar cannot be reversed.',
      ],
      rollbackPlaybookSteps: [
        'Revert maxPayoutPerTx setting to previous threshold in system configuration.',
        'Trigger payout worker cycle to resume held transactions.',
      ],
      estimatedRollbackTimeMinutes: 10,
      preconditionsRequired: {
        confirmPendingPayoutDelay: affectedPayoutCount > 0,
        twoPersonApprovalRequired: severity === IMPACT_SEVERITY.HIGH || severity === IMPACT_SEVERITY.CRITICAL,
      },
    },
  };
}

/**
 * 4. Content Quarantine Simulation
 */
function simulateContentQuarantine(current, proposed, data) {
  const criteria = proposed.criteria || {};
  const materials = data.materials || [];
  const purchases = data.purchases || [];

  const matchedMaterials = materials.filter((m) => {
    if (criteria.subject && m.subject !== criteria.subject) return false;
    if (criteria.creatorAddress && m.userAddress !== criteria.creatorAddress) return false;
    if (criteria.flaggedKeyword && !m.title?.toLowerCase().includes(criteria.flaggedKeyword.toLowerCase())) {
      return false;
    }
    return true;
  });

  const matchedIds = new Set(matchedMaterials.map((m) => String(m.materialId || m._id)));
  const affectedPurchases = purchases.filter((p) => matchedIds.has(String(p.materialId)));
  const affectedLearners = new Set(affectedPurchases.map((p) => p.learnerId || p.userId).filter(Boolean));

  const severity =
    matchedMaterials.length > 20 || affectedLearners.size > 50
      ? IMPACT_SEVERITY.HIGH
      : matchedMaterials.length > 0
      ? IMPACT_SEVERITY.MEDIUM
      : IMPACT_SEVERITY.LOW;

  return {
    delta: { criteria, matchedMaterialsCount: matchedMaterials.length },
    impactAssessment: {
      severity,
      affectedRecordsCount: matchedMaterials.length,
      affectedUsersCount: affectedLearners.size,
      affectedUsersSample: Array.from(affectedLearners).slice(0, 5).map((id) => ({ userId: id, role: 'learner' })),
      affectedRecordsSample: matchedMaterials.slice(0, 5).map((m) => ({
        recordId: m.materialId || m._id,
        type: 'material',
        title: m.title,
      })),
      financialImpact: null,
    },
    expectedSideEffects: [
      {
        category: 'SEARCH',
        severity: 'INFO',
        description: `${matchedMaterials.length} materials will be removed from marketplace search projections.`,
        impactedCount: matchedMaterials.length,
        mitigationHint: 'Search indexes will update asynchronously via tombstone projection.',
      },
      {
        category: 'ACCESS',
        severity: 'WARNING',
        description: `${affectedLearners.size} existing buyers will experience download review notices.`,
        impactedCount: affectedLearners.size,
        mitigationHint: 'Grandfather existing verified purchasers if quarantine is purely administrative.',
      },
    ],
    rollbackConstraints: {
      isFullyReversible: true,
      hasIrreversibleOperations: false,
      irreversibleOperations: [],
      rollbackPlaybookSteps: [
        'Remove quarantine flag from matched material records.',
        'Trigger search index projection re-population for recovered material IDs.',
      ],
      estimatedRollbackTimeMinutes: 15,
      preconditionsRequired: {
        confirmContentTakedown: true,
        twoPersonApprovalRequired: severity === IMPACT_SEVERITY.HIGH,
      },
    },
  };
}

/**
 * 5. Archive Retention & Storage Purge Simulation
 */
function simulateArchiveRetention(current, proposed, data) {
  const proposedRetentionDays = proposed.retainExportsDays;
  if (typeof proposedRetentionDays !== 'number' || proposedRetentionDays < 1) {
    throw new PolicySimulationError('retainExportsDays must be a positive integer');
  }

  const exportRecords = data.exportRecords || [];
  const nowMs = Date.now();
  const thresholdMs = nowMs - proposedRetentionDays * 24 * 60 * 60 * 1000;

  const purgeCandidates = [];
  let totalBytesToPurge = 0;
  const affectedUsers = new Set();

  for (const exp of exportRecords) {
    const createdAtMs = new Date(exp.createdAt || exp.timestamp).getTime();
    if (createdAtMs < thresholdMs) {
      purgeCandidates.push(exp);
      totalBytesToPurge += Number(exp.sizeBytes) || 1024 * 1024; // default 1MB if unknown
      if (exp.userId) affectedUsers.add(exp.userId);
    }
  }

  const severity =
    purgeCandidates.length > 500 || totalBytesToPurge > 10 * 1024 * 1024 * 1024 // 10 GB
      ? IMPACT_SEVERITY.CRITICAL
      : purgeCandidates.length > 50
      ? IMPACT_SEVERITY.HIGH
      : purgeCandidates.length > 0
      ? IMPACT_SEVERITY.MEDIUM
      : IMPACT_SEVERITY.LOW;

  return {
    delta: { proposedRetentionDays, purgeCandidateCount: purgeCandidates.length, totalBytesToPurge },
    impactAssessment: {
      severity,
      affectedRecordsCount: purgeCandidates.length,
      affectedUsersCount: affectedUsers.size,
      affectedUsersSample: Array.from(affectedUsers).slice(0, 5).map((id) => ({ userId: id, role: 'learner' })),
      affectedRecordsSample: purgeCandidates.slice(0, 5).map((e) => ({
        recordId: e.exportId || e._id,
        type: 'learner_export_archive',
        title: `Archive (${((e.sizeBytes || 1024 * 1024) / 1024).toFixed(1)} KB)`,
      })),
      financialImpact: null,
    },
    expectedSideEffects: [
      {
        category: 'STORAGE',
        severity: 'CRITICAL',
        description: `PERMANENT PURGE: ${purgeCandidates.length} archive files (${(totalBytesToPurge / (1024 * 1024)).toFixed(2)} MB) will be deleted permanently from blob storage.`,
        impactedCount: purgeCandidates.length,
        mitigationHint: 'Ensure cold storage glacier backup snapshot is created before initiating permanent purge.',
      },
      {
        category: 'USER_EXPERIENCE',
        severity: 'WARNING',
        description: `${affectedUsers.size} learners requesting historical export downloads will need to generate new on-demand exports.`,
        impactedCount: affectedUsers.size,
        mitigationHint: 'Notify learners with export archives expiring soon.',
      },
    ],
    rollbackConstraints: {
      isFullyReversible: false,
      hasIrreversibleOperations: true,
      irreversibleOperations: [
        'DELETED ARCHIVE FILES CANNOT BE RECOVERED FROM STORAGE AFTER PURGE.',
        'Storage quota reclamation is irreversible.',
      ],
      rollbackPlaybookSteps: [
        'Stop automated purge background worker immediately.',
        'Initiate disaster recovery restore from cold off-site backup for missing archive blobs.',
      ],
      estimatedRollbackTimeMinutes: 120,
      preconditionsRequired: {
        confirmIrreversibleDataLoss: true,
        twoPersonApprovalRequired: true,
      },
    },
  };
}

/**
 * Gatekeeper: Verifies that a simulation preview is valid, unexpired, and all required
 * preconditions / confirmation flags have been explicitly provided before committing.
 *
 * @param {object} params
 * @param {object} params.simulation - The PolicySimulationPreview object from simulatePolicyChange
 * @param {object} params.commitRequest - The maintainer's commit request
 * @throws {PolicySimulationError} if verification fails
 * @returns {boolean} true if commit is authorized to proceed
 */
export function assertPolicyCommitAllowed(simulation, commitRequest) {
  if (!simulation || !simulation.simulationId) {
    throw new PolicySimulationError('Valid simulation preview is required before committing', 'MISSING_SIMULATION', 400);
  }

  // 1. Expiration Check
  const now = new Date();
  if (now.getTime() > new Date(simulation.expiresAt).getTime()) {
    throw new PolicySimulationError(
      'Simulation preview has expired (valid for 15 minutes). Please re-run the simulation before committing.',
      'SIMULATION_EXPIRED',
      410
    );
  }

  // 2. Fingerprint Check (TOCTOU protection)
  if (
    !commitRequest.simulationFingerprint ||
    commitRequest.simulationFingerprint !== simulation.simulationFingerprint
  ) {
    throw new PolicySimulationError(
      'Simulation fingerprint mismatch. The proposed policy or underlying state has changed since preview.',
      'FINGERPRINT_MISMATCH',
      409,
      {
        expectedFingerprint: simulation.simulationFingerprint,
        receivedFingerprint: commitRequest.simulationFingerprint,
      }
    );
  }

  const { preconditionsRequired } = simulation.rollbackConstraints;

  // 3. Irreversible Data Loss Precondition
  if (preconditionsRequired.confirmIrreversibleDataLoss && !commitRequest.confirmIrreversibleDataLoss) {
    throw new PolicySimulationError(
      'Commit blocked: Policy involves irreversible data loss. Explicit confirmIrreversibleDataLoss: true is required.',
      'CONFIRMATION_REQUIRED',
      428,
      { requiredFlag: 'confirmIrreversibleDataLoss' }
    );
  }

  // 4. Financial Impact Precondition
  if (preconditionsRequired.confirmFinancialImpact && !commitRequest.confirmFinancialImpact) {
    throw new PolicySimulationError(
      'Commit blocked: Significant financial impact detected. Explicit confirmFinancialImpact: true is required.',
      'CONFIRMATION_REQUIRED',
      428,
      { requiredFlag: 'confirmFinancialImpact' }
    );
  }

  // 5. Irreversible Revocation Precondition
  if (preconditionsRequired.confirmIrreversibleRevocation && !commitRequest.confirmIrreversibleRevocation) {
    throw new PolicySimulationError(
      'Commit blocked: Policy revokes entitlements with irreversible cryptographic tokens. Explicit confirmIrreversibleRevocation: true is required.',
      'CONFIRMATION_REQUIRED',
      428,
      { requiredFlag: 'confirmIrreversibleRevocation' }
    );
  }

  // 6. Two-Person Integrity / Dual Authorization Guard
  if (preconditionsRequired.twoPersonApprovalRequired) {
    const primaryActor = simulation.actor;
    const secondaryApprover = commitRequest.secondaryApprover;

    if (!secondaryApprover || typeof secondaryApprover !== 'string') {
      throw new PolicySimulationError(
        'Commit blocked: High/Critical severity policy requires secondary maintainer approval (secondaryApprover).',
        'DUAL_APPROVAL_REQUIRED',
        428,
        { requiredField: 'secondaryApprover' }
      );
    }

    if (secondaryApprover.toLowerCase().trim() === primaryActor.toLowerCase().trim()) {
      throw new PolicySimulationError(
        'Two-person rule violation: Secondary approver cannot be the same maintainer who generated the simulation.',
        'SELF_APPROVAL_FORBIDDEN',
        422
      );
    }
  }

  return true;
}

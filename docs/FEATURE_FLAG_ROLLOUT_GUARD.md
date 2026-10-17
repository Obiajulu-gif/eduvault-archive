# Feature-Flag Rollout Guard with Automatic Rollback Verification (#964)

## Overview
EduVault deploys a feature-flag rollout guard designed for releasing risky operational changes (such as new checkout mechanisms, automated payout projections, and archive mutations) safely.

The guard ensures that canary rollouts can be strictly scoped to cohorts of principals, actively monitored against health criteria, automatically rolled back upon error spikes or invariant breaches, and verified post-rollback to leave no orphaned or half-applied records behind.

## Architecture & Lifecycle

### 1. Deterministic Principal Bucketing
Canaries use percentage-based rollouts evaluated deterministically:
$$\text{bucket} = \text{SHA256}(\text{FLAG\_KEY} + ":" + \text{principalId}) \pmod{100}$$
- Principals consistently land in the same cohort without requiring sticky session state.
- Whitelisted principals (e.g. internal testers, QA accounts) are enrolled immediately regardless of rollout percentage.

### 2. Guard Execution Workflow
When executing risky logic under a rollout flag:
```javascript
import { FeatureRolloutGuard } from '@/lib/featureFlags';

const guard = new FeatureRolloutGuard({
  flagKey: 'INSTANT_SETTLEMENTS_V2',
  rolloutPercentage: 25,
  maxConsecutiveFailures: 3,
  errorRateThreshold: 0.05,
});

const result = await guard.execute({
  principalId: userAddress,
  riskyOperation: async () => {
    return processInstantSettlementV2(userAddress);
  },
  fallbackOperation: async () => {
    return processStandardSettlementV1(userAddress);
  },
  invariantCheck: async (res) => {
    return { valid: res.balance >= 0, reason: 'Balance must not be negative' };
  },
  rollbackCleanup: async () => {
    return releaseInflightReservations(userAddress);
  },
  verifyConsistency: async () => {
    const orphans = await countOrphanedReservations(userAddress);
    return { verified: orphans === 0, orphanedRecordsCount: orphans };
  },
  db,
});
```

### 3. Automated Rollback Trigger Criteria
Rollback triggers automatically if:
1. **Consecutive Failures**: The number of consecutive errors meets or exceeds `maxConsecutiveFailures` (default: 3).
2. **Error Rate Spike**: The failure rate exceeds `errorRateThreshold` after `minSamplesForRateCheck` invocations.
3. **Invariant Violation**: The `invariantCheck` returns `valid: false` (e.g. negative balances, orphaned locks, illegal state transitions).

### 4. Post-Rollback Verification
When an automated rollback occurs:
1. Status immediately transitions to `ROLLED_BACK`.
2. All subsequent callers are routed directly to `fallbackOperation`.
3. `rollbackCleanup` is executed to revert uncommitted state.
4. `verifyConsistency` audits system records to guarantee zero orphan records remain.
5. An audit event `feature_flag.automatic_rollback` is written to `auditLedger`.

## Operational Runbook

### Inspecting and Testing Rollouts
Use the CLI to verify bucketing and simulate automated rollbacks:
```bash
# Check if a user is enrolled in a 25% canary:
node scripts/feature-rollout-guard.mjs --flag INSTANT_SETTLEMENTS_V2 --percentage 25 --check-principal GBUYER123

# Simulate failure auto-rollback with clean state verification:
node scripts/feature-rollout-guard.mjs --simulate-failure --json
```

### Rollback Recovery
If a flag is in `ROLLED_BACK` status:
1. Review the failure reason in `guard.getStatus().rollbackReason` or in `auditLedger`.
2. Inspect `postRollbackVerification.verifiedClean` to confirm no database inconsistencies exist.
3. Deploy the fix and create a new guard or reset `guard.status = ROLLOUT_STATUS.ROLLING_OUT`.

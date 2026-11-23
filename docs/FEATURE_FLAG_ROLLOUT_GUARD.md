# Feature-Flag Rollout Guard with Automatic Rollback Verification (#964) & Emergency Disablement (#1152)

## Overview
EduVault deploys a feature-flag rollout guard designed for releasing risky operational changes (such as new checkout mechanisms, automated payout projections, and archive mutations) safely.

The guard ensures that canary rollouts can be strictly scoped to cohorts of principals, actively monitored against health criteria, automatically rolled back upon error spikes or invariant breaches, instantly halted via authorized emergency disablement, and verified post-rollback to leave no orphaned or half-applied records behind.

---

## Architecture & Lifecycle

### 1. Deterministic Principal Bucketing
Canaries use percentage-based rollouts evaluated deterministically:
$$\text{bucket} = \text{SHA256}(\text{FLAG\_KEY} + ":" + \text{principalId}) \pmod{100}$$
- Principals consistently land in the same cohort without requiring sticky session state.
- Whitelisted principals (e.g. internal testers, QA accounts) are enrolled immediately regardless of rollout percentage.

### 2. Guard Execution Workflow
When executing risky logic under a rollout flag:
```javascript
import { FeatureRolloutGuard } from '@/lib/featureFlags/rolloutGuard.js';

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

### 4. Emergency Disablement (#1152)
When an operational incident or zero-day vulnerability occurs, authorized operators can immediately invoke the emergency kill switch:
```javascript
await guard.emergencyDisable({
  actor: { id: 'lead-ops', role: 'admin' },
  reason: 'Upstream Stellar RPC latency causing degraded settlements (INC-4091)',
  rollbackCleanup: async () => releaseInFlightLocks(),
  verifyConsistency: async () => verifyZeroOrphanedTransactions(),
  db,
});
```
- Status immediately transitions to `EMERGENCY_DISABLED`.
- Enforces strict role-based authorization (`admin`, `operator`, `system`, `deployer`).
- Automatically retries transient cleanup/verification errors using exponential backoff ($delay \times 2^{attempt}$).
- Directly routes 100% of incoming callers to `fallbackOperation` with $O(1)$ overhead.
- Records an immutable audit log entry in `auditLedger`.

### 5. Post-Rollback & Post-Disable Consistency Verification
When an automated rollback or emergency disablement occurs:
1. `rollbackCleanup` is executed (with retries) to revert in-flight uncommitted state.
2. `verifyConsistency` audits system records to guarantee zero orphan records remain.
3. A structured post-rollback report is generated:
   ```json
   {
     "timestamp": "2026-11-20T17:23:47.642Z",
     "action": "emergency_disable",
     "disabledBy": "admin-operator",
     "reason": "Operational incident INC-4091",
     "cleanup": { "cleaned": true },
     "consistency": { "verified": true, "orphanedRecordsCount": 0 },
     "verifiedClean": true
   }
   ```

---

## Authorization Model

Sensitive operations (`emergencyDisable`, `reEnable`) require explicit authorization:
- **Allowed Roles**: `admin`, `operator`, `system`, `deployer`.
- **Blocked Roles**: `learner`, `creator`, `viewer`, unauthenticated actors.
- **Enforcement**: Via `assertRolloutGuardAuthorized(actor, action)`:
  - Throws `RolloutAuthorizationError` with code `ERR_ROLLOUT_UNAUTHENTICATED` (HTTP 401) if credentials are absent.
  - Throws `RolloutAuthorizationError` with code `ERR_ROLLOUT_UNAUTHORIZED` (HTTP 403) if role lacks privileges.

---

## Complexity Analysis
- **Time Complexity**:
  - `isEnrolled(principalId)`: $O(1)$ — SHA-256 hash of key + principal followed by modulo calculation.
  - `execute(...)`: $O(1)$ overhead plus operation time. When rolled back or emergency disabled, $O(1)$ dispatch directly to fallback.
  - `emergencyDisable(...)`: $O(1)$ status update + $O(K)$ cleanup where $K$ is in-flight records cleaned.
- **Space Complexity**:
  - $O(W)$ memory where $W$ is the number of whitelisted principals (Set of strings).
  - Metrics state: $O(1)$ bounded numeric counters.

---

## Operational Runbook

### CLI Commands
```bash
# Evaluate enrollment for a specific user
node scripts/feature-rollout-guard.mjs --flag CANARY_PAYOUT_V2 --percentage 25 --check-principal GBUYER123

# Trigger authorized emergency disablement via CLI
node scripts/feature-rollout-guard.mjs --flag CANARY_PAYOUT_V2 --emergency-disable --actor sec-ops --actor-role admin --reason "Circuit breaker tripped due to RPC timeout" --json

# Simulate automated rollback on consecutive failures
node scripts/feature-rollout-guard.mjs --simulate-failure --json
```

### Recovery & Re-Enablement
Once the upstream issue or bug is patched:
```javascript
await guard.reEnable({
  actor: { id: 'admin-lead', role: 'admin' },
  rolloutPercentage: 10, // Restart cautiously at 10%
  whitelist: ['qa-tester-1'],
  db,
});
```
This resets failure counters, clears the rollback status, and safely puts the flag back into `ROLLING_OUT`.

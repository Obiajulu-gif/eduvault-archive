# Explainable Risk Scoring for High-Impact Actions

**Issue #1021** — `src/lib/security/riskScoring.js`

## Overview

The risk scoring module evaluates any *high-impact action* (large purchases,
bulk admin mutations, wallet withdrawals, data exports, etc.) against a set of
configurable signal functions and returns a deterministic, human-readable score
with per-signal explanations.

The design is intentionally:

- **Explainable** — every score includes a `contributors` array listing which
  signals fired, their raw value, their weighted contribution, and a
  plain-English rationale.
- **Stateless** — the scorer is a pure function of the context object; all async
  enrichment (DB queries, IP reputation lookups) happens before `score()` is
  called.
- **Auditable** — every result carries a `policyVersion` fingerprint so a future
  audit can determine whether the scoring logic has changed since a decision was
  recorded.
- **Extensible** — custom signals can be injected via `createRiskScorer({ extraSignals })`.

---

## Risk Levels and Gate Actions

| Level      | Score range | Recommended gate |
|------------|-------------|------------------|
| `low`      | < 0.35      | `allow`          |
| `medium`   | 0.35–0.65   | `flag`           |
| `high`     | 0.65–0.85   | `step_up`        |
| `critical` | ≥ 0.85      | `block`          |

The scorer never enforces these gates — it only recommends. Enforcement is the
caller's responsibility so the same signal set can drive logging-only in staging
and hard blocking in production.

---

## Built-in Signals

| Signal ID                  | Weight | Actions                                           | Description |
|----------------------------|--------|---------------------------------------------------|-------------|
| `new_account`              | 0.20   | all                                               | Account age < 30 days |
| `high_value_transaction`   | 0.25   | `purchase.*`, `wallet.withdrawal`                 | Transaction value ≥ $100 |
| `no_purchase_history`      | 0.15   | `purchase.*`, `wallet.withdrawal`                 | Zero or very few prior purchases |
| `new_device`               | 0.15   | all                                               | Unrecognised device fingerprint |
| `high_velocity`            | 0.20   | all                                               | > 5 actions in the last hour |
| `geo_anomaly`              | 0.15   | all                                               | Geographic / IP anomaly or VPN |
| `privileged_action`        | 0.45   | admin, bulk, export, refund                       | Inherently elevated admin/bulk actions |
| `wallet_recently_changed`  | 0.15   | `wallet.withdrawal`, `purchase.high_value`, `profile.wallet_change` | Wallet changed < 72 hours ago |
| `old_session`              | 0.10   | `wallet.withdrawal`, `admin.*`                    | Session > 60 minutes old |

Weights are normalised per-action so they cannot collectively exceed 1.0.

---

## Context Fields

| Field                         | Type    | Used by signals |
|-------------------------------|---------|-----------------|
| `actorAccountAgeDays`         | number  | `new_account` |
| `actorPreviousPurchases`      | number  | `no_purchase_history` |
| `newDevice`                   | boolean | `new_device` |
| `deviceSeenCount`             | number  | `new_device` |
| `actorActionCountLastHour`    | number  | `high_velocity` |
| `geoAnomaly`                  | boolean | `geo_anomaly` |
| `countryChangedSinceLastLogin`| boolean | `geo_anomaly` |
| `vpnDetected`                 | boolean | `geo_anomaly` |
| `amountUsd`                   | number  | `high_value_transaction` |
| `itemCount`                   | number  | `privileged_action` |
| `walletChangedHoursAgo`       | number  | `wallet_recently_changed` |
| `sessionAgeMinutes`           | number  | `old_session` |

All fields are optional; missing fields are treated as zero / not-fired.

---

## Usage

```js
import {
  scoreAction,
  HIGH_IMPACT_ACTIONS,
  RISK_LEVELS,
  GATE_ACTIONS,
} from "@/lib/security/riskScoring";

const result = scoreAction(HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE, {
  actorAccountAgeDays: 1,
  amountUsd: 480,
  actorPreviousPurchases: 0,
  newDevice: true,
  actorActionCountLastHour: 3,
});

console.log(result.level);       // "high" or "critical"
console.log(result.explanation); // Human-readable explanation
console.log(result.contributors);// Per-signal breakdown

if (result.gate === GATE_ACTIONS[RISK_LEVELS.HIGH]) {
  // Require step-up authentication
}
```

### Custom scorer with extra signals

```js
import { createRiskScorer } from "@/lib/security/riskScoring";

const scorer = createRiskScorer({
  thresholds: { medium: 0.30, high: 0.60, critical: 0.80 },
  extraSignals: [{
    id: "sanctioned_country",
    weight: 0.30,
    actions: null, // apply to all actions
    evaluate(ctx) { return ctx.isSanctionedCountry ? 1.0 : 0; },
    explain(ctx, contribution) {
      return `Origin country is on the sanctions list (contributed ${(contribution * 100).toFixed(1)}%).`;
    },
  }],
});

const result = scorer.score("wallet.withdrawal", { isSanctionedCountry: true });
```

---

## Internal API Endpoint

`POST /api/internal/risk-score`

Protected by admin/service token.

**Request:**
```json
{
  "action": "purchase.high_value",
  "ctx": {
    "actorAccountAgeDays": 1,
    "amountUsd": 800,
    "newDevice": true
  },
  "actorId": "user_abc123"
}
```

**Response:**
```json
{
  "action": "purchase.high_value",
  "score": 0.74,
  "level": "high",
  "gate": "step_up",
  "contributors": [
    {
      "signalId": "high_value_transaction",
      "weight": 0.25,
      "rawValue": 1.0,
      "contribution": 0.27,
      "rationale": "Transaction value of $800.00 exceeds normal thresholds (contributed 27.3%)."
    }
  ],
  "explanation": "Action \"purchase.high_value\" received a risk score of 74.0% — classified as HIGH.\n...",
  "policyVersion": "a3f91c2b8d44",
  "evaluatedAt": "2026-10-17T12:00:00.000Z"
}
```


---

## Evaluation Paths (#1155)

### 1. Normal Path
- The caller invokes `scoreAction(action, ctx)` or `createRiskScorer().score(action, ctx)`.
- Applicable signals are selected, evaluated, and normalized.
- If the score falls below 0.35, the action is marked `low` with gate `allow`.
- If the score is between 0.35 and 0.65, it is marked `medium` with gate `flag`.
- If the score is between 0.65 and 0.85, it is marked `high` with gate `step_up`.
- If the score is 0.85 or higher, it is marked `critical` with gate `block`.
- Results include a deterministic `policyVersion` hash and human-readable explanation.

### 2. Failure Path
- **Invalid Action or Context:** Non-string/empty actions or non-object context inputs throw a strict `TypeError` immediately before evaluation.
- **Faulty Signal Resilience:** If a custom signal's `evaluate()` or `explain()` throws an unhandled error, the scorer isolates the failure, records the error details on the contributor entry, sets its contribution to 0, and continues evaluating the remaining signals without crashing the service.

### 3. Retry Path
- Contexts carrying `retryCount`, `attemptCount`, or `attempt` are evaluated for retry safety.
- Results return `retryable: true` for `low`, `medium`, and `high` risk actions (permitting stepped-up user retry or transient recovery).
- `critical` actions return `retryable: false` to enforce immediate security blocks against automated brute-force attempts.

### 4. Authorization Path
- Programmatic and administrative execution requires authorization.
- `assertRiskScoringAuthorized(actor)` enforces that only callers with role `admin`, `operator`, or `service` may invoke protected scoring routines.
- `scoreAction(action, ctx, { actor })` verifies the actor's privileges and rejects unprivileged callers with `RiskScoringAuthorizationError` (HTTP 403).

---

## Edge Cases, Recovery & Rollback Behavior

- **Zero-Signal / Inactive Context:** A context with no firing signals yields a score of `0.0`, level `low`, and gate `allow`.
- **Weight Normalization Cap:** Normalized signal weights can never exceed 1.0, guaranteeing the aggregated score stays strictly within the `[0, 1]` interval.
- **Policy Version Audit & Drift Detection:** Any change to signal weights or thresholds changes `policyVersion`. Stored audit records from previous versions can be verified for policy drift.
- **Rollback Behavior:** Scoring is completely stateless and side-effect free. To rollback a threshold or signal change, revert configuration options or caller arguments; no database migrations or state clearances are needed.

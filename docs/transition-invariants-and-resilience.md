# Transition Invariants, Degraded Mode, Queue Backpressure, and Deterministic Replay

This document details the architecture, invariant guarantees, operational recovery procedures, and verification suites implemented for:
1. **Transition Invariants for Balance, Ownership, and Entitlement** (#989)
2. **User-Safe Degraded Mode for Unavailable Dependencies** (#988)
3. **Bounded Queue Backpressure for Expensive Background Work** (#984)
4. **Deterministic Replay Verification for Concurrent Writes and Retries** (#983)

---

## 1. Transition Invariants (#989)

### Guarantees
- **Balance Conservation**:
  - `toBalance === fromBalance + delta`.
  - Non-negativity invariant: `toBalance >= 0` unless `allowNegative: true` is explicitly granted.
  - Debit Authorization: Debit transitions strictly require that `actor === authorizedAccount`.
  - Currency Consistency: Disallows cross-currency mutations without explicit conversion.
  - Multi-party Settlement Invariant: In multi-party settlements, `sum(debits) === sum(credits) + platformFee`.
- **Single Ownership & Transfer Authorization**:
  - Exactly one active owner per resource.
  - Proposed recipient must be distinct from current owner.
  - Target address must be non-empty and well-formed.
  - Resources in `ARCHIVED` or `QUARANTINED` status cannot undergo ownership transfer.
  - Transfers must be executed by current owner or a verified administrator.
- **Entitlement State Transitions**:
  - Directed acyclic lifecycle transitions:
    - `NONE -> PENDING` or `NONE -> ACTIVE`
    - `PENDING -> ACTIVE` or `PENDING -> FAILED`
    - `ACTIVE -> REVOKED`, `ACTIVE -> REFUNDED`, or `ACTIVE -> EXPIRED`
  - Proof Enforcement: Transition to `ACTIVE` requires a valid `purchaseId` or `txHash`.
  - Temporal Validity: `validFrom <= validUntil`.
- **Execution & Rollback Calculation**:
  - `executeWithInvariantProtection({ type, transitionParams, executeFn, db })` executes mutations inside an invariant envelope.
  - If mid-mutation execution fails, deterministic rollback instructions are computed and attached to the exception, logging to `audit_ledger`.

---

## 2. User-Safe Degraded Mode for Unavailable Dependencies (#988)

### Guarantees
- **Authorization Boundary Invariant**:
  - Authentication and authorization checks are enforced **before** checking dependency availability or serving fallbacks.
  - Unauthenticated requests fail with `401 UNAUTHENTICATED`.
  - Unauthorized requests fail with `403 FORBIDDEN`.
  - Degraded mode fallback is **never** used to bypass or mask security rejections.
- **Zero Information Leakage**:
  - Strips MongoDB connection URIs (`mongodb+srv://...`), Pinata API keys, Stellar secret keys (`S...`), bearer tokens, internal IP ranges (`10.x`, `172.16-31.x`, `192.168.x`, `127.0.0.1`), internal hostnames (`*.internal`, `*.local`), and stack traces.
- **Critical Financial Mutation Protection**:
  - Tier-1 mutations (purchases, payments, balance transfers) strictly block with `DEPENDENCY_UNAVAILABLE_CRITICAL_BLOCKED` and `retryAfter` guidance.
  - Prevents desynchronized partial states on the Stellar ledger or database.
- **Graceful Content Fallback**:
  - Tier-2 read operations (course previews, content manifests) gracefully serve cached snapshots with `readOnly: true` and sanitized warnings.
- **Circuit Breaker & Observability**:
  - Tracks consecutive failures; transitions states (`HEALTHY -> DEGRADED -> UNAVAILABLE`).
  - Emits sanitized telemetry events (`DEPENDENCY_STATE_CHANGED`, `CRITICAL_OPERATION_BLOCKED`, `FALLBACK_SERVED`).

---

## 3. Bounded Queue Backpressure (#984)

### Guarantees
- **Bounded Capacity & Hard Limits**:
  - Prevents unbounded memory growth in background job queues.
  - Enforces `maxCapacity` (default 200).
- **Hysteresis Watermarks**:
  - `highWaterMark` (80% default): Enters `SHEDDING_LOW_PRIORITY` mode. Low-priority jobs (speculative caching, periodic garbage collection) are rejected with `QueueBackpressureError` (HTTP 429), while normal/high jobs continue.
  - `lowWaterMark` (50% default): Queue depth must drop below the low water mark before returning to `NORMAL` state, preventing rapid oscillation.
- **Per-Job-Type Quotas**:
  - Prevents any single expensive job type (e.g. `storage:pin-verification`, `integrity:verification`) from starving other workflows.
- **Structured Client Signals**:
  - Throws `QueueBackpressureError` with `status: 429`, `code: 'QUEUE_BACKPRESSURE_SATURATED'`, `retryAfterSeconds`, and non-sensitive depth metrics.

---

## 4. Deterministic Replay Tests for Concurrent Writes and Retries (#983)

### Guarantees
- **Bit-for-Bit Deterministic Trace Reproducibility**:
  - All concurrency yield points in the scheduling harness use a seeded PRNG (`mulberry32`).
  - Given the same seed, running complex multi-actor race conditions produces identical execution traces, scheduling orders, and database outcomes.
- **Idempotency Under Concurrent Contention**:
  - Multiple concurrent actors submitting identical or overlapping purchase requests settle to a single winner without double-allocation.
- **Deterministic Invariant Rollback**:
  - Injected transient network failures trigger deterministic rollback calculations, verifying that aborted mutations return to strictly identical checkpoints upon replay.

---

## Verification & Test Suites

- `tests/backend/transitionInvariants.test.mjs`: 23 tests covering balance, ownership, entitlement invariants, and rollback calculations.
- `tests/backend/userSafeDegradedMode.test.mjs`: 10 tests verifying sanitization, authorization boundaries, transient retries, and critical financial blocking.
- `tests/backend/boundedQueueBackpressure.test.mjs`: 6 tests covering capacity admission, priority shedding, saturation, per-job limits, and hysteresis recovery.
- `tests/backend/deterministicReplay.test.mjs`: Node test suite verifying trace equality across duplicate seeded runs.
- `test/concurrency/deterministicReplay.test.js`: Vitest concurrency suite with 3 comprehensive multi-actor scenarios exploring interleavings, versioned writes, idempotency, and rollback recovery.

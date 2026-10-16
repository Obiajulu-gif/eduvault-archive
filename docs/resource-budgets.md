# Resource Budget Ceilings & Enforcement (#959)

## Overview

EduVault establishes explicit resource budget ceilings to guarantee that worst-case workloads do not degrade production latency, exhaust worker memory, or cause database connection starvation.

These budgets are tested and enforced in CI and local test runs via `tests/backend/resource-budgets.test.mjs`.

---

## 1. Workload Scenarios & Budget Ceilings

### A. High-Cardinality Marketplace Search & Ranking Workload
- **Scenario**: Full catalog scan across 10,000+ items with multi-token keyword search (`search: 'algebra'`), category constraints (`category: 'math'`), relevance scoring, and pagination over 10 consecutive pages (240 records delivered).
- **Budget Ceilings**:
  - **CPU Latency**: `< 500ms` total execution time for complete filter + rank + 10-page slice.
  - **Memory Growth**: Peak heap expansion `< 40MB` during execution.
  - **Query Count**: Zero N+1 queries. Single compound index utilization (`visibility_1_category_1_price_1_createdAt_-1`).

### B. High-Volume Cryptographic Ledger Verification Workload
- **Scenario**: Continuous chain generation, SHA-256 canonical hashing, and deep anomaly scanning across 1,000+ financial and privileged events.
- **Budget Ceilings**:
  - **Chain Hashing Throughput**: 1,000 records hashed and linked in `< 600ms` (minimum throughput of 1,600 ops/sec).
  - **Deep Anomaly Verification**: Recomputing hashes, checking sequence continuity, and validating chronological timestamps across 1,000 records in `< 400ms`.
  - **Memory per Record**: Sub-kilobyte footprint per ledger entry during stream processing.

### C. High-Cardinality User Entitlements & Licensing Workload
- **Scenario**: Institutional accounts or multi-seat enterprise learners possessing 2,000+ active resource entitlements, validating access permissions, license types, and expiration dates.
- **Budget Ceilings**:
  - **Batch Check Latency**: 2,000 permission evaluations in `< 50ms`.
  - **Per-Item Check Overhead**: Average check latency `< 25μs`.
  - **Time Complexity**: $O(1)$ lookup guarantees with zero memory leaks across sustained iterations.

### D. Deep Object Canonicalization Workload
- **Scenario**: Complex financial payloads with 200+ nested keys and ISO timestamps requiring deterministic sorting and serialization.
- **Budget Ceilings**:
  - **Execution Time**: `< 15ms` per 200-key payload.
  - **Determinism**: 100% byte-for-byte reproducibility regardless of key insertion order.

---

## 2. Operational Failure Modes & Edge Cases

| Failure Mode | Root Cause | Impact | Automated Mitigation |
| :--- | :--- | :--- | :--- |
| **Search Query Degradation** | Lack of compound index coverage on soft-deleted or unapproved rows | Database collection scan, query time spikes `> 1000ms`, CPU saturation | Use indexed compound projections (`materialSearchDocuments`). If latency exceeds 250ms, the query falls back to cached cursor results. |
| **Worker Heap Starvation** | Loading unbounded ledger history into memory for audit exports | Node.js process out-of-memory (`ERR_WORKER_OUT_OF_MEMORY`) | Export endpoints enforce strict pagination (`limit <= 5000`) and stream records rather than buffering arrays. |
| **Entitlement Cache Stampede** | Multiple concurrent downloads for an account with thousands of licenses | Redundant database lookups hitting entitlement collections | Local memory LRU cache with 60-second TTL protects backend datastore. |

---

## 3. Rollback & Recovery Procedures

### If Search Resource Budgets Are Violated
1. Check index health using `npm run db:indexes`.
2. Inspect slow queries using MongoDB `explain("executionStats")`.
3. If search projection index is stale, run `scripts/benchmark-marketplace-search.mjs` and trigger reconciliation.

### If Ledger Verification Budgets Are Violated
1. Check for oversized unstructured JSON blobs in `intent` or `beforeState` / `afterState`.
2. Ensure checkpoint compaction is running via `src/lib/backend/financialAuditLedger.js`.
3. Tune node V8 memory flags (`--max-old-space-size=4096`) on audit export workers.

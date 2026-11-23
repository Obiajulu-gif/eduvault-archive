# Worst-Case Cardinality and Burst Traffic Load Testing

This document specifies the architecture, load testing methodology, resource budgets, and operational runbook for **worst-case cardinality and burst traffic** in EduVault.

---

## 1. Overview and Problem Statement

EduVault's marketplace combines multifaceted discovery, full-text relevance ranking, IPFS metadata references, and role-based entitlement checks. Under high-scale conditions, two distinct vectors stress backend performance and stability:

1. **Worst-Case Cardinality**:
   - **Query & Facet Combinations**: Deeply combinatorial queries joining multiple subjects (30+ taxonomies), categories (15+), licenses, languages, content types, and high-cardinality tags (150+ pool, up to 12 tags per item).
   - **Search Token Explosion**: Multi-token search queries triggering regex tokenization, stop-word filtering, and fuzzy scoring across 6 fields.
   - **Rate Limiter Bucket Explosion**: Adversarial traffic spoofing high-cardinality client IPs / user agents to exhaust in-memory sliding window maps (`inMemoryBuckets`).
2. **Burst Traffic Spikes**:
   - High-concurrency traffic bursts (e.g. flash course drops, institutional onboarding, viral academic links).
   - Rate limiting thresholds (HTTP 429), circuit breaker engagement (HTTP 503), and retry storms hitting write endpoints.
   - Concurrency race conditions testing tenant isolation and authorization boundaries under simultaneous load.

To safeguard system availability, EduVault provides an executable load suite in [`src/lib/backend/burstCardinalityLoadSuite.js`](../src/lib/backend/burstCardinalityLoadSuite.js) and automated verification tests in [`tests/backend/load-worst-case-cardinality-burst.test.mjs`](../tests/backend/load-worst-case-cardinality-burst.test.mjs).

---

## 2. Path Coverage & Acceptance Criteria

| Path | Scenario | Expected Behavior | Budget / Invariant |
|---|---|---|---|
| **Normal** | 200 concurrent requests across 25 workers over 5,000 high-cardinality items | Stable query filtering, ranking, and cursor pagination | `p95 < 400ms`, `p50 < 300ms`, `minRps >= 75`, `heapDelta <= 60MB`, 100% 200 OK |
| **Normal** | Multi-tag keyword intersection across 5,000 items | Linear/sub-linear filtering over array tags | Query duration `< 30ms` |
| **Failure** | Adversarial long tokens and control characters | Sanitization strips control chars, bounds tokens to `<= 10` | Exec duration `< 15ms`, zero ReDoS |
| **Failure** | Rate limiter bucket exhaustion (10,000 unique client keys) | LRU / capacity eviction bounds cache size | Bucket size capped at `maxBuckets` (e.g. 500) |
| **Failure** | Malformed / negative limits, invalid base64 cursors | Gracefully rejected with standard error envelope | HTTP 400 Bad Request, zero unhandled errors |
| **Retry** | Hot client exceeding sliding window limit | Throttled with standard retry headers | HTTP 429, `retryAfter >= 1`, resets after window |
| **Retry** | 100 clients backing off simultaneously | Full jitter exponential backoff | Delays bounded by `[0, min(maxDelay, baseDelay * 2^attempt)]`, high entropy |
| **Retry** | 50 concurrent retries of same high-risk write with idempotency key | Deduplication executes side effect once and replays result | Exactly 1 mutation, 100% 200 OK, zero duplicate charges |
| **Authorization** | 150 mixed-role requests (`PUBLIC`, `BUYER`, `CREATOR`, `ADMIN`, `CROSS_TENANT`) | Strict role-based field sanitization under concurrency | ZERO leakage of `downloadUrl`, `rawStoragePath`, `internalReviewFlags`, `routingKey` in public |
| **Authorization** | Tampered or invalid authentication tokens | Fast rejection before database access | HTTP 401, `p95 < 10ms` |

---

## 3. Mathematical Models for Burst & Retry

### 3.1 Full Jitter Exponential Backoff

To prevent the **thundering herd problem** where clients retry at identical synchronized intervals, EduVault mandates full jitter exponential backoff:

$$\text{sleep} = \text{uniform\_random}(0, \min(T_{\text{max}}, T_{\text{base}} \times 2^{\text{attempt}}))$$

Where:
- $T_{\text{base}} = 50\text{ ms}$ (default base backoff)
- $T_{\text{max}} = 2000\text{ ms}$ (maximum ceiling)
- $\text{attempt} = \text{retry count (0-indexed)}$

### 3.2 Sliding Window Rate Limiting

The sliding window algorithm evaluates timestamps within the current rolling window:

$$W(t) = [t - \Delta t_{\text{window}}, t]$$

If $|\{ \tau \in W(t) \}| < L_{\text{limit}}$, the request is allowed. Otherwise, it is rejected with:

$$\text{retryAfter} = \left\lceil \frac{\tau_{\text{oldest}} + \Delta t_{\text{window}} - t}{1000} \right\rceil$$

---

## 4. Operational Edge Cases & Mitigations

### 4.1 Memory Ballooning from High-Cardinality Client Keys
- **Threat**: An attacker generates thousands of randomized `User-Agent` or forwarded IP headers to force `inMemoryBuckets` to allocate unbounded Map entries.
- **Mitigation**: `createBoundedRateLimiter` enforces `maxBuckets` capacity with LRU eviction of the oldest buckets when capacity is reached, preventing out-of-memory (OOM) crashes.

### 4.2 Regular Expression Catastrophic Backtracking (ReDoS)
- **Threat**: Crafted regex or nested repetitive search tokens cause exponential backtracking in token matching.
- **Mitigation**: `tokenizeMarketplaceSearch` clamps token count to a maximum of 10, strips non-printable ASCII control characters (`\u0000-\u001F`), and limits raw input to 120 characters before applying escaped regex clauses.

### 4.3 Concurrent Retry Storms on Write Endpoints
- **Threat**: Network timeouts cause 50+ clients to re-issue purchases simultaneously.
- **Mitigation**: High-risk write routes must wrap mutations in `withIdempotency()` using atomic `in_progress` locks. Duplicate keys during in-flight executions receive `CONFLICT_IN_PROGRESS`, while subsequent calls receive the canonical replayed result without duplicate execution.

### 4.4 Cross-Tenant Data Leaks Under Concurrency
- **Threat**: Concurrency race conditions or shared variable mutation causing Buyer A to view Buyer B's private download URL or credentials.
- **Mitigation**: Pure functional sanitization via `sanitizeMaterialForRole()`. Sanitization creates new immutable object projections, preventing prototype pollution or shared references across concurrent request contexts.

---

## 5. Recovery and Rollback Behavior

### 5.1 Automated Shedding & Circuit Breakers
1. **HTTP 429 Too Many Requests**: Edge proxies and application rate limiters shed excess burst traffic without invoking database connections.
2. **Degraded Mode (HTTP 503 / 202)**: When Stellar RPC or Pinata IPFS latency spikes above threshold, the degradation matrix trips, serving cached listings or queuing async operations.

### 5.2 Emergency Rollback & Throttle Tuning Runbook
If burst traffic threatens system stability:

1. **Immediate Rate Limit Tightening**:
   - Reduce route rate limits in environment variables or Redis configuration:
     ```bash
     MARKETPLACE_RATE_LIMIT=30
     RATE_LIMIT_WINDOW_MS=60000
     ```
2. **Purge Volatile Rate Limit Buckets**:
   - Reset in-memory rate limiters or flush rate limit keys in Redis:
     ```javascript
     import { resetRateLimits } from '@/lib/api/rateLimit.js';
     resetRateLimits();
     ```
3. **Verify Heap Stability**:
   - Check process heap usage using Node.js diagnostic inspection or memory metrics:
     ```bash
     node --inspect scripts/journey-monitor.mjs
     ```
4. **Run Load Test Suite**:
   - Verify baseline stability against worst-case cardinality:
     ```bash
     node --test tests/backend/load-worst-case-cardinality-burst.test.mjs
     ```

---

## 6. Backward Compatibility & Migration Plan

- **Non-breaking Architecture**: The load testing suite (`burstCardinalityLoadSuite.js`) provides additive benchmarking and verification primitives without mutating existing route contracts or database schemas.
- **Existing Contracts Preserved**:
  - `checkRateLimit` and `slidingWindowRateLimit` remain backward compatible.
  - Public catalog endpoints maintain standard error shapes and legacy pagination fallbacks.
  - Existing `docs/backend-contracts.md` and `docs/tasks/marketplace-performance-audit.md` budgets remain enforceable.

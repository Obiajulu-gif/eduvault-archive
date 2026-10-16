# Tamper-Evident Chronological Ledger (#958)

## Overview

EduVault implements a cryptographically verifiable, append-only chronological ledger (`src/lib/backend/financialAuditLedger.js`) for all privileged administrative actions (role updates, suspensions, quarantines) and financial events (payouts, refunds, purchases, scholarship redemptions).

The ledger builds upon SHA-256 hash chaining, deterministic canonicalization, monotonic sequence numbers, and strict timestamp monotonicity to provide tamper evidence and external auditability.

---

## 1. Cryptographic Design & Guarantees

### A. SHA-256 Hash Chaining
Every ledger record hashes its own canonicalized JSON contents along with the hash of the preceding record:
```
Record[0].previousHash = 0000000000000000000000000000000000000000000000000000000000000000 (Genesis)
Record[0].recordHash   = SHA256(canonicalize(Record[0].content))

Record[1].previousHash = Record[0].recordHash
Record[1].recordHash   = SHA256(canonicalize(Record[1].content))
...
Record[N].previousHash = Record[N-1].recordHash
Record[N].recordHash   = SHA256(canonicalize(Record[N].content))
```

### B. Deterministic Canonicalization
To guarantee identical digests across environments and runtimes:
- All keys in JSON objects are recursively sorted lexicographically.
- Date objects are converted to ISO 8601 UTC strings.
- Numbers and booleans maintain strict JSON representation.

### C. Monotonicity & Chronological Ordering
- `sequence` numbers are consecutive integers starting at `0`.
- Every entry's `timestamp` must be greater than or equal to the prior entry's `timestamp`. Any attempt to append an older timestamp fails immediately with a `Chronological inversion` error.

---

## 2. Anomaly & Tamper Detection

The integrity engine `verifyLedgerIntegrity(records)` inspects the entire chain or a sequence slice:

| Anomaly Type | Condition Detected | Recovery Action |
| :--- | :--- | :--- |
| `CONTENT_MODIFICATION` | `SHA256(content) != recordHash` | Record has been modified post-creation. Alert security team; restore corrupted record from off-site verifiable replica. |
| `BROKEN_CHAIN` | `record.previousHash != prior.recordHash` | Record has been inserted out-of-order or chained to an unauthorized block. |
| `SEQUENCE_GAP` | `record.sequence != expectedIndex` | One or more ledger records were deleted. Review database binary logs and audit checkpoints. |
| `CHRONOLOGICAL_INVERSION` | `record.timestamp < prior.timestamp` | System clock skew or unauthorized timestamp tampering. Synchronize NTP daemons. |

---

## 3. Verifiable Exports & Integrity Receipts

The ledger provides automated exports via `exportLedger(db, options)`:
- Formats: JSON or CSV.
- Filtering by domain (`financial`, `privileged`), event type, or timestamp range.
- Each export includes an **Integrity Receipt**:
  - `recordCount`: Total records in the export.
  - `firstSequence` & `lastSequence`: Boundary sequence numbers.
  - `firstHash` & `lastHash`: Boundary cryptographic hashes.
  - `isCompleteChainVerified`: Boolean confirming continuous zero-error verification from genesis.
  - `exportChecksum`: SHA-256 digest of the ordered list of all record hashes.

---

## 4. Operational Edge Cases & Recovery Procedures

### Edge Case 1: High-Concurrency Sequence Collisions
- **Symptom**: Multiple workers attempt to append records concurrently, resulting in duplicate key error (`E11000`) on `sequence`.
- **Handling**: `appendLedgerRecord` implements an automated retry loop (up to 5 attempts) reading the latest chain head and recalculating `sequence` and `previousHash`.

### Edge Case 2: Database Restoration / Split-Brain Recovery
- **Symptom**: A database restore leaves the ledger in a state missing recent transactions.
- **Recovery**:
  1. Export the existing restored ledger with `exportLedger`.
  2. Replay verified historical events from the immutable outbox and block explorer receipts using idempotent `operationId`s.
  3. Run `npm run validate:restore` to certify chain unbroken status.

### Edge Case 3: Rollback Procedures
- The ledger is append-only. Modifying or deleting existing entries is strictly forbidden by cryptographic design.
- To reverse an erroneous action:
  1. Do NOT delete or modify the erroneous record.
  2. Append a new compensating ledger entry (e.g. `REFUND_EXECUTED`, `USER_REACTIVATED`, or `BALANCE_ADJUSTMENT`).
  3. Reference the original `operationId` in the `target` or `reason` metadata.

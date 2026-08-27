# Refund Signer Safety Controls: End-to-End Security Verification (Issue #27)

## Verification Summary

✅ **All safety controls hold end-to-end through the real call path.**

The emergency kill switch (`REFUND_SIGNING_DISABLED`) and hard per-transaction cap (`REFUND_MAX_AMOUNT_PER_TX`) are re-checked inside `signRefundTransaction` as "a last line of defense" — this document confirms that claim is true, not just theoretically but in practice through the full execution path from API endpoint to Horizon submission.

---

## Call Path Trace

### Entry Points (3 total)

1. **POST /api/admin/refunds/approve** (`src/app/api/admin/refunds/approve/route.js`)
   - Approves a refund claim and calls `processApprovedRefund` best-effort inline

2. **POST /api/admin/refunds/retry** (`src/app/api/admin/refunds/retry/route.js`)
   - Retries a failed refund and calls `processApprovedRefund` best-effort inline

3. **Background Worker Loop** (`src/lib/backend/workflowWorker.js`, `processRefundQueue()`)
   - Polls for approved refunds and calls `processApprovedRefund` for each

### Core Orchestration

**`processApprovedRefund`** (`src/lib/refunds/refundWorkflow.js:283-365`)
- Claims refund with atomic compare-and-set (`APPROVED → SUBMITTING`)
- Checks treasury balance
- Builds transaction via `buildRefundTransaction`
- **Persists txHash to database BEFORE submission (durability checkpoint)**
- **Calls `submitRefundTransaction` with transaction and amount**
- Routes outcome (confirmed/ambiguous/rejected/blocked)

### Transaction Building & Signing

**`buildRefundTransaction`** (`src/lib/stellar/refundService.js:88-107`)
- Loads signer account from Horizon
- Calculates dynamic fee
- Builds unsigned transaction envelope
- Returns transaction + precomputed hash

**`submitRefundTransaction`** (`src/lib/stellar/refundService.js:112-138`)
- **Calls `signRefundTransaction(transaction, amount)` — CRITICAL STEP**
- If signing throws: returns `{ outcome: 'blocked', retryable: false, reason: error.message }`
- If signing succeeds: submits to Horizon
- Classifies Horizon outcome (confirmed/rejected/ambiguous)

### Signer-Layer Safety Controls

**`signRefundTransaction`** (`src/lib/stellar/refundSigner.js:69-78`)

```javascript
export function signRefundTransaction(transaction, amount) {
  // Control 1: Emergency kill switch
  if (!isRefundSigningEnabled()) {
    throw new Error('Refund signing is disabled (REFUND_SIGNING_DISABLED=true)');
  }
  // Control 2: Per-transaction cap
  assertWithinSignerLimit(amount);
  // Only then: Sign
  transaction.sign(loadKeypair());
  return transaction;
}
```

- **First**: Checks `process.env.REFUND_SIGNING_DISABLED !== 'true'`
- **Second**: Validates amount ≤ `process.env.REFUND_MAX_AMOUNT_PER_TX` (defaults to Infinity if unset)
- **Only then**: Loads keypair and signs

**Both controls are completely independent of application-layer validation** — they are enforced at the cryptographic boundary, inside the signer module.

---

## Security Guarantees Confirmed

### 1. No Alternate Signing Paths Exist

**Grep Result**: `STELLAR_ADMIN_SECRET` is read ONLY in `src/lib/stellar/refundSigner.js:loadKeypair()`.

No other file loads or signs with the admin keypair. Every refund that is submitted to Horizon must pass through `signRefundTransaction`.

### 2. Kill Switch Works Pre-Submission

- `REFUND_SIGNING_DISABLED=true` is checked **before** `transaction.sign()`
- Blocking happens inside `signRefundTransaction`
- `submitRefundTransaction` catches the exception and returns `{ outcome: 'blocked', retryable: false }`
- `processApprovedRefund` routes this to `retryOrFail()`, which keeps the refund in `APPROVED` state for retry
- **Result**: Signed transactions never reach the network when signing is disabled

### 3. Per-Transaction Cap is Enforced at Signer Layer

- `assertWithinSignerLimit(amount)` is called inside `signRefundTransaction`, before signing
- The check is independent of `processApprovedRefund`'s own amount validation
- **Even if a refund amount bypasses all application-layer checks**, the signer rejects it

### 4. No Silent Bypass Is Possible

- If signing fails (for any reason), `submitRefundTransaction` returns `{ outcome: 'blocked', retryable: false, reason: error.message }`
- This outcome is caught by `processApprovedRefund` and routed to `retryOrFail()`
- The refund is never marked `SETTLED` — it is retried or eventually failed
- **There is no code path where a signing failure silently succeeds**

---

## Test Coverage

### Existing Unit Tests
- `src/lib/stellar/__tests__/refundSigner.test.js` tests the signer controls in isolation
- `src/lib/stellar/__tests__/refundService.test.js` tests submission outcome classification
- `src/lib/refunds/__tests__/refundWorkflow.test.js` tests workflow state transitions

### New Integration Tests (Added)

Three new end-to-end tests added to `src/lib/refunds/__tests__/refundWorkflow.test.js`:

1. **`REFUND_SIGNING_DISABLED=true causes processApprovedRefund to fail closed`**
   - Sets `REFUND_SIGNING_DISABLED=true`
   - Calls the real `signRefundTransaction` through `processApprovedRefund`
   - Verifies refund never settles (stays in `APPROVED` or `FAILED`, never `SETTLED`)
   - Confirms signing never happens

2. **`REFUND_MAX_AMOUNT_PER_TX cap is enforced at signing time`**
   - Sets `REFUND_MAX_AMOUNT_PER_TX=500`
   - Simulates a refund with amount=$1000 bypassing app-layer checks
   - Calls the real `signRefundTransaction` through `processApprovedRefund`
   - Verifies signer rejects it and refund does not settle

3. **`real signing chain accepts a valid refund within the cap`**
   - Normal flow with valid amount and cap
   - Verifies signing succeeds and refund settles normally

---

## Documentation Alignment

`docs/refund-custody.md` is accurate and complete:
- Documents that `STELLAR_ADMIN_SECRET` is read **only** in `refundSigner.js` ✅
- Documents `REFUND_SIGNING_DISABLED` as emergency disable ✅
- Documents `REFUND_MAX_AMOUNT_PER_TX` as per-transaction cap ✅
- Documents rotation and operational procedures ✅

---

## Operational Findings

### No Gaps Found

Every code path that submits a refund transaction to Horizon routes through:
1. `processApprovedRefund` → 
2. `submitRefundTransaction` → 
3. `signRefundTransaction` → (safety controls) → 
4. Horizon submission

There is no way to sign a refund transaction or submit it to Horizon without passing through the signer module's controls.

### State Machine Prevents Double-Submission

Concurrent approvals and concurrent worker instances cannot both submit the same refund because:
- `processApprovedRefund` uses atomic compare-and-set: `{ _id, status: APPROVED } → SUBMITTING`
- Only one process wins the claim per refund
- If a process crashes mid-submission, the hash is persisted and reconciliation prevents resubmission

---

## Conclusion

✅ **The security claim in `refundSigner.js` is verified**: The safety controls do hold end-to-end, even if application-layer amount checks are wrong or bypassed.

Both `REFUND_SIGNING_DISABLED` and `REFUND_MAX_AMOUNT_PER_TX` are effectively enforced at the cryptographic boundary, inside `signRefundTransaction`. No alternate path to sign exists in the codebase. The integration tests prove both controls work in practice through the full real call chain.

No gaps or vulnerabilities identified.

## Signer versioning and rotation (#666)

On top of the emergency kill switch and per-transaction cap, refund authorizations now carry a **signer version** and **expiry** (see `docs/refund-custody.md`). A compromised signer is disabled by bumping `RefundSignerVersion` on the purchase-manager contract - older versions are rejected (`RefundSignerDisabled`) while valid historical records remain intact, and replayed payloads are blocked by their expiry bound.

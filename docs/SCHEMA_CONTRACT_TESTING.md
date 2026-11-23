# Cross-Layer Schema Contract Testing (#1191)

This document describes the cross-layer schema contract registry and automated
verification suite spanning EduVault's **Soroban contracts**, **Next.js API
routes**, and **frontend service clients**.

- **Contract registry & validators**: `src/lib/contracts/crossLayerSchemaContracts.js`
- **Automated contract test suite**: `tests/backend/schema-contract-cross-layer.test.mjs`
- **Soroban ABI source of truth**: `soroban/contracts/shared-interface/src/lib.rs`
- **Frontend service clients**: `src/services/purchaseService.js`, `src/services/materialService.js`

---

## Running Verification

```bash
node --test tests/backend/schema-contract-cross-layer.test.mjs
```

It also runs automatically as part of CI via:

```bash
npm run test:backend
```

---

## Covered Boundaries

1. **Soroban Contracts ↔ Shared Registry**:
   - Directly parses `soroban/contracts/shared-interface/src/lib.rs` and verifies:
     - Enum discriminants (`MaterialStatus`, `AssetKind`) have not been removed or reordered.
     - Decimal precision constants (`NATIVE_XLM_DECIMALS = 7`, `USDC_DECIMALS = 7`) remain synchronized.
     - `MaterialView` cross-contract struct fields match.
     - All 5 canonical on-chain event schemas (`MATERIAL_REGISTERED`, `MATERIAL_SALE_TERMS_UPDATED`, `PURCHASE_COMPLETED`, `PURCHASE_BULK_COMPLETED`, `PURCHASE_REFUNDED`) and `ENTITLEMENT_STATUS_FIELDS` match topic and payload field ordering.
2. **API Request & Response Contracts**:
   - Validates normal (`200`, `201`), pending/retry (`200` idempotent replay, `202` pending, `429` retryable), failure (`400`, `404`, `409`), and authorization (`401`, `403`) payloads across `/api/purchase`, `/api/checkout/refund`, `/api/materials/access`, `/api/entitlements/batch`, and `/api/market-materials`.
3. **Frontend Services ↔ API Contracts**:
   - Directly parses `src/services/purchaseService.js` and `src/services/materialService.js` to confirm every client method calls a registered API route path.
4. **Authorization Redaction Contract**:
   - `verifyAuthorizationErrorContract` verifies `401` and `403` responses conform to `ERROR_RESPONSE_SCHEMA` and never leak sensitive fields (`storageKey`, `fileUrl`, `signedXdr`, `privateKey`, `jwtSecret`, `passwordHash`).

---

## Edge Cases

1. **Additive vs. Breaking Schema Changes**:
   - Adding optional properties or appending new enum variants is backwards compatible (`validateSchemaEvolution` passes).
   - Removing/renaming required fields, adding new required fields for existing producers, changing field types, or removing/reordering Soroban enum discriminants fails `validateSchemaEvolution`.
2. **Soroban XDR Map Decoding**:
   - Soroban `#[contracttype]` structs decode by field name. Readers with fewer fields ignore unknown trailing entries, but readers expecting a field absent from stored on-chain data fail to decode.
3. **Idempotent Retries & Pending Settlement**:
   - Retried checkout mutations may return `200` (already completed), `202` (still pending), or `429` (`retryAfter` seconds). All three states have explicit response schemas so frontend callers handle retries deterministically.
4. **Null vs. Omitted Optional Fields**:
   - Nullable response fields (`transactionHash`, `nextCursor`, `amount`, `asset`) explicitly allow `['string', 'null']` or `['number', 'null']` to prevent false failures on uninitialized records.

---

## Recovery, Rollback & Migration Plan

### Safe Rollout Order for Breaking Changes (Expand–Contract)

1. **Expand**: Add new optional fields or append new enum variants in `soroban/contracts/shared-interface/src/lib.rs` and `src/lib/contracts/crossLayerSchemaContracts.js` without removing existing fields.
2. **Deploy Contracts in Order**: Deploy `material-registry` first, then `purchase-manager` (matching `shared-interface` rollout rules).
3. **Deploy API & Frontend**: Update API handlers to dual-read/write old and new fields, then update frontend services.
4. **Contract (Major Version)**: Only after all producers/consumers have migrated, bump the schema version and remove deprecated fields.

### Recovery & Rollback

- Because contract tests are purely additive verification artifacts with zero runtime side effects on existing routes, rolling back a schema contract change is a standard single-commit revert.
- If a contract/API mismatch is detected in CI, block the deployment before contracts are upgraded so on-chain storage and indexers never desync.

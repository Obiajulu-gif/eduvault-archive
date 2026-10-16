# Creator Profile Dual-Wallet Schema Migrations

## Overview
Creator profiles in EduVault use wallet-based authentication. When evolving profile schemas (such as supporting Stellar public keys alongside EVM addresses), migrations must be **zero-downtime, idempotent, and resumable**, ensuring active sessions and onboarding flows never break.

## Design Principles
1. **Dual-Read Path Fallbacks**:
   - `buildWalletLookupQuery(address)` queries across all legacy and modern fields simultaneously (`walletAddress`, `walletAddressLower`, `stellarWalletAddress`, `evmWalletAddress`, `wallets.stellar`, `wallets.evm`).
   - `normalizeProfileForSession(user)` normalizes in-flight, partial, and legacy documents dynamically so application and authentication logic always find required wallet fields.
2. **Non-Destructive Additions**:
   - New schema fields (`stellarWalletAddress`, `evmWalletAddress`, `wallets`, `schemaVersion: 2`) are written alongside existing `walletAddress` without removing legacy fields until a future cutover window.
3. **Resumable Batched Checkpointing**:
   - Progress is checkpointed in MongoDB (`migration_checkpoints` collection) under `_id: "creator_profile_wallet_schema_v2"`.
   - The job queries `{ _id: { $gt: lastProcessedId } }` sorted by `_id: 1` in configurable batches. If the process is halted or restarted, it picks up precisely where it left off without duplicating or skipping records.
4. **Dry-Run & Rollback Validation**:
   - Running with `--dry-run` performs full document validation and outputs sample document diffs without modifying data.
   - Running with `--rollback` safely unsets version 2 fields and clears the checkpoint.

## Operational Commands

### Dry Run (Pre-Flight Verification)
```bash
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/migrations/migrate-creator-profiles.mjs --dry-run
```

### Full Rollout
```bash
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/migrations/migrate-creator-profiles.mjs --batch-size=100
```

### Rollback (If Needed)
```bash
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/migrations/migrate-creator-profiles.mjs --rollback
```

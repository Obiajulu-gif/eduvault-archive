# Payout Milestone JSON Migration Runbook

Issue: #110

## Goal

Move legacy `payouts.milestones` JSON into normalized Mongo collections without downtime:

- `milestones`
- `milestone_evidence`
- `milestone_transitions`
- `milestone_migration_exceptions`

The rollout is reversible while the legacy JSON remains on `payouts`.

## Expand

1. Deploy the code that contains migration `004-normalize-payout-milestones`.
2. Keep legacy `payouts.milestones` reads enabled. `listPayoutMilestones` reads normalized rows first and falls back to the JSON payload when no rows exist.
3. Run:

```bash
npm run db:migrate
```

Use `MILESTONE_BACKFILL_BATCH_SIZE` to tune batch size. The migration stores checkpoints in `_schema_migrations`, so interrupted runs resume after the last processed payout.

## Backfill

Migration 004 processes every payout document where `milestones` exists, including empty arrays, `null`, object-wrapped payloads, and stringified JSON.

Malformed payloads are not discarded. They are recorded in `milestone_migration_exceptions` with:

- `exceptionId`
- `migrationVersion`
- `payoutId`
- `milestoneIndex`
- `reason`
- `rawValue`

Known reasons include `malformed_json`, `unsupported_payload_shape`, `malformed_milestone`, `invalid_amount`, and `amount_total_mismatch`.

## Verify

Migration 004 verifies source and target totals before completing:

- source milestone count
- source migratable milestone count
- target milestone row count
- source milestone amount total
- target milestone amount total

If counts or totals differ, the migration fails before clearing its checkpoint. Inspect:

```javascript
db.milestone_migration_exceptions.find({ migrationVersion: 4 }).sort({ createdAt: -1 })
db._schema_migrations.findOne({ version: 4 })
```

Fix the reported legacy payloads or decide on a product-approved mapping, then rerun `npm run db:migrate`.

## Contract

Only after verification has passed in production:

1. Switch write paths to `transitionMilestoneStatus` or equivalent row-level update functions.
2. Stop writing whole `payouts.milestones` JSON documents.
3. Monitor duplicate-key errors on `milestones_payout_position_unique` and version conflicts with code `MILESTONE_VERSION_CONFLICT`.
4. In a later migration, remove the legacy JSON field after backups and downstream consumers are confirmed clean.

## Rollback

Rollback is safe before the contract phase because the legacy JSON remains intact.

1. Revert the application deployment to a version that reads `payouts.milestones`.
2. If normalized rows must be removed, run migration 004 `down` from an operational script or targeted migration runner. It deletes only rows marked `migrationVersion: 4` and `migratedFromLegacyJson: true`, plus migration 004 evidence, transitions, exception records, and `payouts.milestoneBackfill`.
3. Rerun `npm run db:migrate` after redeploying the normalized code.

## Operational Notes

MongoDB cannot enforce cross-document milestone amount totals with a native check constraint. Migration verification and the exception report are the enforcement mechanism during rollout. Application writes should validate payout totals before creating or reordering milestones.

Concurrent status changes must include the caller's expected milestone `version`. A stale version fails instead of overwriting a newer update.

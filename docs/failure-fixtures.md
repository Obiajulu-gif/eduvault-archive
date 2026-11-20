# Rare Failure Fixtures and Repair Paths (#881)

Some failure states are rare but costly: a paid purchase that never granted
access, a refunded buyer who still has access, a purchase pointing at a
deleted material. They are hard to reproduce by hand. This catalog gives each
one a deterministic fixture and a documented repair path, and tests keep both
honest.

- Catalog: [`scripts/lib/failure-fixtures.mjs`](../scripts/lib/failure-fixtures.mjs). Side-effect free, with fixed ids and dates.
- Loader: [`scripts/load-failure-fixtures.mjs`](../scripts/load-failure-fixtures.mjs).
- Detector: the integrity monitor rules in [`scripts/lib/integrity-rules.mjs`](../scripts/lib/integrity-rules.mjs) (see [data-integrity-monitor.md](data-integrity-monitor.md)).

## Fixtures

| Fixture | Failure state | Detected by | Repair |
| --- | --- | --- | --- |
| `stale-pending-purchase-paid-onchain` | Purchase `pending` for 3 days although its tx confirmed on-chain | `stale_pending_purchases` | **Automated.** The payment reconciler (`POST /api/webhooks/stellar`) confirms it and grants access |
| `orphaned-entitlement-after-refund` | Active `entitlement_cache` row for a refunded purchase | `active_entitlement_without_purchase` | **Script.** `node scripts/rebuild-entitlement-cache.mjs --repair` deletes it |
| `purchase-for-hard-deleted-material` | Confirmed purchase whose material row was hard-deleted | `purchases_missing_material` | **Manual.** Restore from backup, or insert a soft-deleted tombstone |
| `duplicate-wallet-profiles` | Two profiles with one wallet address | `duplicate_wallet_addresses` | **Manual.** Merge into the oldest profile, revoke the duplicate's sessions, delete it |
| `stale-dead-letter-event` | Indexer dead-letter event `retryable` for 10 days | `stale_dead_letter_events` | **Script.** `node scripts/indexer-deadletter.mjs retry <eventId>`, or quarantine it |

`node scripts/load-failure-fixtures.mjs --list` prints every fixture with its
full step-by-step repair instructions and the expected end state. Add `--now` (or
`--now=<ISO>`) to generate the fixtures relative to that clock instead of the
fixed `FIXTURE_NOW`, so time-based rules flag them the same way on a live
database.

## Using a fixture locally

```bash
# 1. Load the failure state (idempotent; re-running restores it exactly)
node scripts/load-failure-fixtures.mjs orphaned-entitlement-after-refund --detect
# {"event":"failure_fixtures_loaded",...}
# {"event":"integrity_detected","violations":["active_entitlement_without_purchase"]}

# 2. Follow the repair path
DRY_RUN=true node scripts/rebuild-entitlement-cache.mjs --repair
node scripts/rebuild-entitlement-cache.mjs --repair

# 3. Confirm it is cleared, then clean up
node scripts/integrity-monitor.mjs
node scripts/load-failure-fixtures.mjs --unload
```

`MONGODB_URI` (default `mongodb://localhost:27017/eduvault`) and `MONGODB_DB`
(default `eduvault`) select the database. The loader refuses to run when the
resolved environment is `staging` or `production` (`EDUVAULT_DEPLOY_ENV`,
`VERCEL_ENV`, `NODE_ENV`). `--unload` removes only fixture rows. Every fixture
`_id` starts with `fa11ed`.

## How fixtures stay valid

`tests/backend/failure-fixtures.test.mjs` fails when a fixture drifts from the
code:

| Check | Catches |
| --- | --- |
| All fixtures load into `users` / `materials` collections created with the real `ProfileSchema` / `MaterialSchema` validators (strict) | Schema changes the fixture doesn't satisfy |
| Each fixture, loaded alone, is flagged by **exactly** the rules in `detectedBy` | Renamed fields, changed rule logic, fixtures that trigger unrelated rules |
| Every `detectedBy` id exists, every repair has steps, an expected state, and a command when it isn't manual | Stale documentation |
| Shared documents (baseline creator, buyer, material) are identical across fixtures | Loading several fixtures together silently changing data |
| The automated, script and manual repair paths each clear their fixture | Broken repair tooling |
| The loader CLI loads and detects, and refuses `production` | Loader regressions |

```bash
npx tsx --test tests/backend/failure-fixtures.test.mjs
```

## Adding a fixture

1. Add an entry to `FAILURE_FIXTURES` with fixed `fa11ed…` ids and dates relative to `FIXTURE_NOW`. Reuse the baseline documents where possible.
2. List the integrity rules that must flag it in `detectedBy`. If no rule detects the state yet, add one to `integrity-rules.mjs` first.
3. Document the repair: `kind`, `command` (for automated or script repairs), `steps`, `expected`.
4. Add a repair-flow test when the repair is automated or scripted.

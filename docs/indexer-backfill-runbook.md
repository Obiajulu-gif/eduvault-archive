# Indexer ledger backfill and reconciliation

Run a dry reconciliation first:

`node scripts/reconcile-ledgers.mjs --network=TESTNET --contracts=C... --start=100 --end=500`

Add `--repair --apply` only after reviewing the stored reconciliation report.
Jobs checkpoint their RPC cursor and manifest, so rerunning the same range/job
resumes safely. Repairs use the normal idempotent projection path. Divergent or
extra records are reported for investigation and are never silently overwritten
or deleted. If RPC history has been pruned, restore an archival RPC endpoint and
restart with the same job id.

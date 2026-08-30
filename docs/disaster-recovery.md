# Disaster Recovery & System Restoration Procedures

This document outlines the step-by-step technical procedures required to restore the EduVault system state following a hardware outage, database corruption, or environment-wide deployment failure.

---

## 1. Core Database Restoration (MongoDB)

EduVault utilizes MongoDB to store operational profiles, marketplace listings metadata, and cached indexing events.

### Snapshot / Backup Creation

To generate an on-demand compressed binary backup snapshot of the production or staging instance:

```bash
mongodump --uri="$MONGODB_URI" --gzip --archive=./eduvault_backup_$(date +%F).archive
```

### Full Restoration Steps

In the event of active data corruption or provisioning of a blank replacement node:

1. Verify network connectivity and ensure the targeted environment variables (`MONGODB_URI`) are configured correctly.
2. Clear any lingering broken collection indexes or invalid states if operating on a contaminated live container.
3. Execute the binary restoration tool against the target database URI:

```bash
mongorestore --uri="$MONGODB_URI" --drop --gzip --archive=./eduvault_backup_TIMESTAMP.archive
```

> **Note:** The `--drop` flag ensures that existing collections matching the archive schema are safely removed before restoring clean historical data.

---

## 2. IPFS Storage Synchronization (Pinata)

Educational marketplace materials and media assets are permanently hosted on IPFS. Pinata serves as the platform's pinning infrastructure gateway.

### Resyncing Pin Bounds

If asset resolution endpoints stall or local media trackers lose file hash synchronization:

1. Verify that the deployment environment contains a valid `PINATA_JWT` configuration.
2. Use Pinata gateway validation tools or internal verification modules to confirm asset integrity against expected storage references.
3. If an individual content identifier (`CID`) becomes unavailable, re-register or re-pin the target asset using the authoritative repository reference hash through the standard content ingestion pipeline.

---

## 3. Blockchain Event Log Resynchronization & Re-indexing

EduVault maintains an off-chain MongoDB cache of on-chain contract activity. If the database becomes corrupted or falls behind ledger state, the cache can be reconstructed using Stellar indexer tooling.

### Step 1: Wipe the Outdated or Corrupt Index Cache

If indexing state becomes unsynchronized or corrupted, remove the affected cache collections before replaying events:

```bash
# Connect to your MongoDB shell environment
mongosh "$MONGODB_URI" --eval "db.materials.drop();"
```

### Step 2: Validate Environment Variables

Ensure the indexer is configured with the correct contract addresses and RPC endpoints.

Example configuration:

```env
NEXT_PUBLIC_STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID=CC...
NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID=CC...
```

### Step 3: Run the Off-Chain Re-indexing Script

Execute the dedicated indexing process to replay historical blockchain events and reconstruct database state:

```bash
npm run indexer:stellar
```

This process rebuilds:

- Materials collections
- Event mirrors
- Search indexes
- Derived marketplace metadata

### Step 3b: Partial Ledger Replay (Backfill)

To replay a bounded ledger range (e.g. after bugs or outages) without rebuilding the entire index, run the partial backfill command:

```bash
npm run indexer:stellar:backfill -- --start=LEDGER_START --end=LEDGER_END
```

The backfill process:
- Uses stable keys to ignore duplicate events preserving idempotency.
- Operates on a defined checkpoint and backfill state model independent of the main indexer cursor.
- Automatically handles missing checkpoints or interrupted backfills by tracking `backfillRange`.

### Step 4: Verify Restoration Success

Confirm that indexing completed successfully by reviewing system logs:

```json
{
  "event": "stellar_indexer_batch_complete",
  "processedEvents": "X",
  "success": true
}
```

Verify that:

- All expected collections exist
- Compound indexes are recreated
- Event counts align with ledger expectations
- No indexing failures are reported

---

## 4. Post-Recovery Security Sanity Audits

Before reopening the environment to public traffic, verify that no credentials, secrets, or temporary recovery artifacts have been exposed during restoration activities.

Run the security scan:

```bash
npm run scan:secrets
```

Expected output:

```text
No obvious secrets or placeholder production values found.
```

### Additional Verification Checklist

- Confirm production environment variables are loaded correctly.
- Remove temporary backup archives from ephemeral storage if no longer required.
- Validate IPFS asset availability.
- Verify Stellar contract connectivity.
- Confirm database backups are scheduled and functioning.
- Review application logs for unexpected authentication or indexing failures.

---

## 5. Entitlement Cache Rebuild Verification (Issue #682)

The entitlement cache is a **derived** view of on-chain purchases — when it is
restored from a stale snapshot it can silently grant or deny access that no
longer matches the source of truth. `scripts/rebuild-entitlement-cache.mjs`
makes the rebuild executable and verifiable.

### Verification-only run (compare current cache against source of truth)

```bash
MONGODB_URI="$MONGODB_URI" node scripts/rebuild-entitlement-cache.mjs
```

Reports **missing** (should be active but not cached), **extra** (active in cache
but no completed purchase — likely refunded), and **mismatched** entitlements
alongside the totals. Exit code `0` = every protected download matches
source-of-truth purchases; exit code `1` = discrepancies found (and emits the
remediation hint).

### Full DR rebuild (drop + repopulate cache from purchases)

```bash
MONGODB_URI="$MONGODB_URI" node scripts/rebuild-entitlement-cache.mjs --rebuild
```

Clears `entitlement_cache` and repopulates it from completed `purchases`
records (`confirmed` / `settled` / `completed`). Add `DRY_RUN=true` to compute
the report without writing.

### RPO / RTO targets

| Metric | EditalVault target | Notes |
|---|---|---|
| **RPO** (Recovery Point Objective) | ≤ 15 minutes of purchases | Daily mongodump snapshots plus the indexer replay keep lost confirmations ≤ 15 min |
| **RTO** (Recovery Time Objective) | ≤ 60 minutes | Cache rebuild + verification typically completes in minutes for normal collection sizes |
| **Backup schedule** | Daily snapshot (mongodump archive) | Retain at least 7 backups; off-site copy recommended |

### Operator checklist (post-restore)

1. Restore Mongo from snapshot (`mongorestore … --drop --archive=…`).
2. Run `restore-verification.mjs` against the restored archive and confirm exit `0`.
3. Run `npm run indexer:stellar` to replay on-chain events (materials/events).
4. Run `scripts/rebuild-entitlement-cache.mjs` (verification-only). Confirm **no**
   missing/extra/mismatched. If discrepancies exist, run `--rebuild`.
5. Re-run verification; expect exit `0`.
6. Run `npm run scan:secrets` and confirm a clean result.
7. Spot-check protected downloads for a creator-owned and a purchased material.

Mismatches are the highest-signal failure: they mean the cache and the chain
disagree on who *should* have access — resolve before reopening traffic.

---

## 6. Protected Material & Entitlement Restore Verification Drill (Issue #715)

Backups are only valid if restored protected materials remain accessible to entitled buyers and access control policy is accurately enforced post-restore.

### Verification Procedure

Execute the extended verification script on the restored database:

```bash
MONGODB_URI="$STAGING_URI" JWT_SECRET="$JWT_SECRET" node scripts/restore-verification.mjs ./eduvault_backup.archive
```

The script automatically validates:
1. **Secret & Key Integrity:** Verifies required decryption and token signing secrets (`JWT_SECRET` ≥ 32 characters, `MONGODB_URI`).
2. **Content Hash & Storage References:** Confirms every protected material (paid or private) has a valid CID/storage reference and uncorrupted file hash.
3. **Zero-Trust Entitlement Decisions:**
   - Proves entitled buyers (with active cache or settled purchase) are granted access.
   - Proves synthetic unentitled callers are strictly denied access.
   - Confirms refunded/revoked purchases cannot access protected content.

### Secret and Key Handling During Restore Drills

> [!IMPORTANT]
> - **Production Decryption Secrets:** Never export unencrypted production keys or write raw `JWT_SECRET` strings to temporary restore drill log files or shell histories.
> - **Staging Isolation:** Always execute restore drills against isolated staging databases (`MONGODB_DB=eduvault_dr_test`).
> - **Secret Verification:** Ensure `JWT_SECRET` matches the key used by the target API instance; a key mismatch will prevent legitimate buyers from decrypting material links.

### Operator Restore Drill Checklist

- [ ] Obtain database backup archive (`.archive` / `.gz`).
- [ ] Restore archive to isolated staging MongoDB instance using `mongorestore --drop`.
- [ ] Export required secrets (`MONGODB_URI`, `JWT_SECRET`, `PINATA_JWT`).
- [ ] Run `node scripts/restore-verification.mjs <archive.gz>` and confirm exit code `0`.
- [ ] Execute `node scripts/check-ipfs-integrity.mjs` to verify IPFS pin availability.
- [ ] Execute automated backend restore verification tests: `node --test tests/backend/restore-verification.test.mjs`.

### Failure Actions & Remediation Matrix

| Verification Failure | Root Cause | Operator Action |
|---|---|---|
| **Secret check failed (`JWT_SECRET`)** | `JWT_SECRET` missing or < 32 characters in environment | Configure valid `JWT_SECRET` environment variable (≥ 32 chars) matching API environment. |
| **Missing file reference / CID** | Material document restored without `storageKey` or `ipfsCid` | Check indexer sync state or re-fetch material metadata from Stellar contract registry. |
| **Content hash mismatch / corruption** | `fileHash` or `contentHash` invalid or truncated | Re-pin asset on Pinata via `node scripts/check-ipfs-integrity.mjs AUTO_REPAIR=true` and update hash. |
| **Entitled buyer access denied** | Discrepancy between `purchases` and `entitlement_cache` | Run `node scripts/rebuild-entitlement-cache.mjs --rebuild` to synchronize cache with purchases. |
| **Unentitled access leak** | Active cache record exists for non-purchaser | Drop invalid `entitlement_cache` entries and re-run indexer/cache rebuild. |

---

## Recovery Completion Criteria

The recovery process can be considered complete when:

- MongoDB data has been successfully restored.
- IPFS-hosted assets are accessible and correctly pinned.
- Stellar event caches have been fully rebuilt.
- Search indexes have been regenerated.
- Security scans pass without findings.
- Restore verification script (`restore-verification.mjs`) reports 0 violations.
- Application health checks report normal operational status.
- User-facing functionality has been validated in the restored environment.
- Monitoring and alerting systems are operational.

---

## References

- MongoDB Backup & Restore Procedures
- Pinata IPFS Infrastructure Documentation
- Stellar Soroban RPC Documentation
- EduVault Indexer Operations Guide
- Internal Security Incident Response Procedures


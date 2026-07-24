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
# Single batch, exits when done. Repeat until `drained` is true, or run
# `npm run indexer:stellar` to let the service drain the backlog itself.
npm run indexer:stellar:once
```

This process rebuilds:

- Materials collections
- Event mirrors
- Search indexes
- Derived marketplace metadata

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

## Recovery Completion Criteria

The recovery process can be considered complete when:

- MongoDB data has been successfully restored.
- IPFS-hosted assets are accessible and correctly pinned.
- Stellar event caches have been fully rebuilt.
- Search indexes have been regenerated.
- Security scans pass without findings.
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

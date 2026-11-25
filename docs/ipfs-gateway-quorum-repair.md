# IPFS Content Repair Job with Gateway Quorum Checks (#1204)

## Overview

EduVault stores digital educational materials and their associated metadata on IPFS pinned through Pinata and secondary pinning providers.
Relying on a single gateway or pinning API can lead to dead links if a provider experiences downtime, de-indexes content, or fails silently.

The **IPFS Content Repair Job** (`src/lib/storage/ipfsContentRepair.js` and `scripts/repair-ipfs-content.mjs`) actively audits content reachability across independent public and private IPFS gateways (e.g. Pinata, IPFS.io, Cloudflare). It requires an independent **gateway quorum** consensus before considering a CID healthy, re-pins degraded content from reachable gateways, and quarantines permanently dead assets.

---

## Quorum Consensus Model

For every material `storageKey` (CID), parallel probes query configured gateways:

| Status | Consensus Condition | Action |
|---|---|---|
| `healthy` | At least `requiredQuorum` (default: 2) gateways return HTTP 200 | No action required. |
| `degraded` | Fewer than `requiredQuorum` gateways respond, but at least 1 is healthy | Content retrieved from the healthy gateway and re-pinned to failed/missing secondary providers to restore quorum. |
| `unreachable` | 0 gateways respond with healthy content | Item flagged as unreachable, logged to `ipfs_repair_quarantine`, and alerted for maintainer recovery. |

---

## CLI Usage

```bash
# 1. Dry run (default: inspect all material CIDs and report quorum status)
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/repair-ipfs-content.mjs

# 2. Execute repair (re-pins degraded CIDs to satisfy quorum)
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/repair-ipfs-content.mjs --apply

# 3. Custom quorum threshold (e.g. require 3 independent gateways)
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/repair-ipfs-content.mjs --quorum=3 --apply

# 4. Target a specific CID or Material ID
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/repair-ipfs-content.mjs --target-cid=bafybei... --apply
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/repair-ipfs-content.mjs --target-material=64f1... --apply

# 5. Output JSON summary (for monitoring / alerts)
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/repair-ipfs-content.mjs --json
```

Or via npm scripts:
```bash
npm run repair:ipfs        # dry-run
npm run repair:ipfs:apply  # apply
```

---

## Reliability, Failure Handling & Retries

1. **Parallel Probes with Timeouts**:
   - Each gateway probe uses `AbortController` timeouts (default: 5,000ms) to prevent slow or hanging gateways from stalling the job.
2. **Exponential Backoff**:
   - Re-pinning degraded content retries with exponential backoff if a pinning provider is temporarily rate-limited.
3. **Quarantine Collection (`ipfs_repair_quarantine`)**:
   - Unreachable CIDs are recorded with their failed gateway HTTP codes and timestamps, enabling maintainers to restore from offline cold storage backups.
4. **Audit Trail (`ipfs_repair_audit`)**:
   - Every apply run records an audit document detailing scanned CIDs, healthy count, repaired count, quarantined count, and operator identity.

---

## Authorization

- Requires authentication and one of the following:
  - Role: `admin`, `deployer`, `maintainer`, or
  - Permissions: `storage:manage`, `system:repair`, `admin:manage`, or
  - Trusted CLI execution (`{ isCli: true }`).
- Unauthorized requests throw `AUTH_FORBIDDEN` (`403`) or `AUTH_UNAUTHENTICATED` (`401`).

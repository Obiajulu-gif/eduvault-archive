# Release Readiness Engine: Migrations, Smoke Tests & Rollback Rehearsal

## Overview
The **Release Readiness Engine** (`src/lib/release/releaseReadiness.js` and `scripts/release-readiness.mjs`) automates pre-release verification across four pillars before any code or database migration is shipped to staging or production:
1. **Deployment Authorization**: Ensures only authorized release operators (`admin`, `deployer`, `release_engineer`, or tokens with `system:release` / `system:migrate`) can promote releases.
2. **Migration & Schema Safety**: Inspects registered database migrations, verifies schema completeness across core collections, and blocks any pending migrations lacking down-migration / rollback capability.
3. **Transient-Resilient Smoke Tests**: Performs synthetic write/read/delete canary transactions against the database with configurable exponential-backoff retries.
4. **Rollback Rehearsal & Snapshot Freshness**: Validates that backup snapshots exist, are fresh (<24 hours), and that rollback procedures have been rehearsed.

## CLI Usage

Run standard pre-flight verification:
```bash
npm run release:readiness
# or
node scripts/release-readiness.mjs
```

Run in strict mode (fails on warnings as well as errors) with output reporting:
```bash
npm run release:readiness:strict -- --actor=devops-lead --out=release-readiness-report.json
```

For offline or CI dry-run checks:
```bash
node scripts/release-readiness.mjs --dry-run --skip-db
```

## Readiness Pillars & Decision Matrix

| Pillar | Passing Criteria | Warning Condition | Blocking Failure |
| :--- | :--- | :--- | :--- |
| **Authorization** | Role is `admin`, `deployer`, `release_engineer` or has `system:release` | N/A | Missing actor or unpermitted role (e.g. `guest`, `learner`) |
| **Environment** | `JWT_SECRET` and `NEXT_PUBLIC_STELLAR_NETWORK` present | Non-standard network name | Missing required secret keys |
| **Migrations** | All collections present, all pending migrations reversible | Pending migrations ready to apply | Irreversible migrations pending; missing schema |
| **Smoke Tests** | Synthetic write-read-delete cycle succeeds within timeout | Transient retry succeeded | Database offline or read-after-write consistency failure |
| **Rollback** | Snapshot timestamp <24h old and rehearsal documented | Snapshot between 24h–48h old | No verified snapshot found; invalid timestamp |

### Decision Outcomes
- **`PROCEED`**: All 5 checks passed. Release pipeline advances.
- **`REQUIRES_APPROVAL`**: Warnings present (e.g., pending migrations ready to apply). Permitted in standard mode; blocked in strict mode.
- **`BLOCKED`**: One or more critical failures. Process exits with code `1` immediately halting CI/CD.

## Rollback & Emergency Recovery Procedures

### 1. Pre-Deployment Snapshot
Before triggering production deployment:
```bash
# Capture snapshot timestamp in environment
export LAST_BACKUP_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
```

### 2. Rollback Execution
If post-release monitoring detects anomalous error rates:
1. Revert application code container to previous release tag.
2. Execute migration rollback (down-migration) using the corresponding rollback script:
   ```bash
   node scripts/migrations/<migration-name>.mjs --rollback
   ```
3. If database inconsistency is detected, restore from the verified snapshot captured in `LAST_BACKUP_TIMESTAMP`.
4. Rerun `npm run release:readiness:strict` to verify cluster stability after rollback.

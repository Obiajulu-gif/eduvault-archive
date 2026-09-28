# Data Retention Policy

## Overview

This document defines retention requirements for EduVault operational data, specifying how long records are kept, what protections apply, and when cleanup is performed.

## Retention Categories

### Permanent Retention (Never Delete)

These records have indefinite retention due to financial, legal, or audit requirements:

| Collection | Rationale |
|------------|-----------|
| `audit_ledger` | Admin action audit trail required for compliance |
| `purchases` | Financial transaction records required for tax/legal |
| `refund_requests` | Financial dispute records required for settlements |

### Time-Limited Retention

| Collection | Retention Period | Protection Conditions |
|------------|------------------|----------------------|
| `material_history` | 2 years after material deletion | Protected while linked material exists |
| `sync_events` | 90 days | None |
| `dead_letter_events` | 90 days after resolution | Protected while status is pending/quarantined/retrying |
| `notifications` | 180 days after read | Protected while unread |
| `sessions` | 30 days after expiry | None |
| `rate_limits` | 7 days | None |
| `outbox` | 14 days after completion | Protected while status is pending/retrying/failed |
| `cache_entries` | 7 days after last access | None |
| `search_analytics` | 365 days | None |
| `entitlement_cache` | 90 days of inactivity | Protected while active and not expired |
| `quarantine` | 30 days after resolution | Protected while status is quarantined/scanning/pending_review |

## Protection Rules

### Linked Material Protection
Material history records are retained as long as the referenced material exists in the catalog, even if it exceeds the retention period.

### Active Status Protection
Records with active operational status are protected from cleanup:
- Dead letter events with status `pending`, `quarantined`, or `retrying`
- Outbox intents with status `pending`, `retrying`, or `failed`
- Quarantine records with status `quarantined`, `scanning`, or `pending_review`

### User Interaction Protection
Records awaiting user action are protected:
- Unread notifications (regardless of age)
- Active entitlement cache entries with future expiration

### Financial Settlement Protection
Any record linked to an active dispute, pending refund, or unsettled transaction is automatically protected from cleanup, regardless of age.

## Cleanup Execution

### Automated Cleanup Schedule

The retention cleanup script runs automatically via cron:
```bash
# Daily at 2 AM UTC
0 2 * * * cd /app && node scripts/data-retention-cleanup.mjs --execute
```

### Manual Execution

**Dry-run mode** (default, reports only):
```bash
node scripts/data-retention-cleanup.mjs
```

**Execute mode** (performs deletion):
```bash
node scripts/data-retention-cleanup.mjs --execute
```

### Reporting

Each cleanup run generates:
1. **Structured JSON logs** for log aggregators
2. **Summary report** with totals per collection
3. **Sample records** showing what would be/was deleted
4. **Protection report** listing why records were protected

Example output:
```
================================================================================
DATA RETENTION CLEANUP REPORT
================================================================================
Timestamp: 2024-11-07T02:00:00.000Z
Mode: EXECUTE
Total Collections: 15
Processed: 12
Skipped: 3
Failed: 0
Total Eligible Records: 1,247
Total Deleted Records: 1,247
================================================================================
```

## Testing

### Validation Script

Verify retention policy configuration:
```bash
node scripts/data-retention-cleanup.mjs
```

Expected: No errors, report shows eligible records per collection.

### Test Coverage

Automated tests validate:
- ✅ Protected records are never deleted
- ✅ Eligible records within retention window are preserved
- ✅ Expired records outside retention window are identified correctly
- ✅ Protection conditions are evaluated correctly
- ✅ Dry-run mode never modifies data

Test file: `tests/backend/data-retention-cleanup.test.mjs`

## Compliance

### GDPR Right to Erasure

User-initiated deletion requests override retention policies. When a user exercises their right to erasure:
1. Personal identifiable information is redacted immediately
2. Financial/legal records are pseudonymized (user ID → UUID)
3. Audit trail records transaction history without PII

### Data Minimization

Retention periods are set to the minimum required for:
- Operational integrity (sync events, sessions)
- Support & debugging (dead letters, quarantine)
- Analytics & optimization (search analytics)
- Legal compliance (purchases, audits)

## Migration & Rollout

### Phase 1: Documentation & Review ✅
- Document retention requirements
- Review with legal/compliance
- Obtain maintainer approval

### Phase 2: Implementation ✅
- Build cleanup script with protection checks
- Add dry-run validation mode
- Write automated tests

### Phase 3: Validation (In Progress)
- Run dry-run on staging database
- Review cleanup reports
- Verify protection conditions

### Phase 4: Production Rollout (Pending)
- Deploy script to production environment
- Configure cron schedule
- Monitor first 3 cleanup runs manually
- Enable automated alerting on failures

## Monitoring & Alerts

### Success Metrics
- Cleanup completes within 5 minutes
- No protected records are deleted
- Disk usage remains stable over time
- Exit code 0 (no failures)

### Alert Conditions
- Cleanup duration > 10 minutes
- Failed collection cleanup (exit code 1)
- Protected record violation detected
- Unexpected spike in deleted records (>10x average)

## References

- Implementation: `scripts/data-retention-cleanup.mjs`
- Tests: `tests/backend/data-retention-cleanup.test.mjs`
- Privacy policy: `docs/data-retention-and-privacy.md`
- Backup verification: `docs/disaster-recovery.md`

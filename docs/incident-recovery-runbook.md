# Incident Recovery Runbook with Executable Checks (#1110)

This runbook guides maintainers and incident commanders (ICs) responding to production incidents across EduVault's architecture: Next.js marketplace, MongoDB persistence, Pinata/IPFS content storage, and Stellar/Soroban smart contract integrations.

---

## 1. Incident Classification & Roles

| Severity | Definition & Impact | Commander Action | Review Cadence |
| :--- | :--- | :--- | :--- |
| **SEV-1** | Unauthorized content access, wallet authority breach, incorrect settlement or refund signing, complete checkout/download outage. | Page security lead & IC; immediately halt unsafe path with emergency kill switches; open war room. | Every 15–30 minutes until contained. |
| **SEV-2** | Indexer cursor lag > 50 ledgers, IPFS gateway degradation, outbox dead-letter spike, non-blocking payout delay. | Assign IC and operations responder; contain and begin resumable repairs. | Every 60 minutes. |
| **SEV-3** | Isolated creator/buyer record discrepancy, single retryable webhook failure, non-critical dashboard telemetry bug. | File tracked ticket, schedule repair during next operational maintenance window. | At handoff and closure. |

---

## 2. Emergency Containment & Kill Switches

When a path is compromised or data corruption is detected, **contain first, diagnose second**.

### A. Automated Refund Signing Emergency Kill Switch
- **Mechanism**: Set environment variable `REFUND_SIGNING_DISABLED=true` and redeploy or restart workers.
- **Fail-Closed Guarantee**: Causes `assertRefundSigningEnabled()` to immediately reject all automated refund transactions with `REFUND_SIGNING_DISABLED`.
- **Manual Override**: Requires dual-maintainer approval receipt before disengaging.

### B. Signer Per-Transaction Cap Limit
- **Mechanism**: Enforced by `assertWithinSignerLimit(amount)` via `REFUND_MAX_AMOUNT_PER_TX`.
- **Behavior**: Any refund transaction exceeding the threshold is rejected outright, preventing treasury drain during compromised state.

### C. Stellar Indexer Cursor Preservation
- **Caution**: **NEVER delete `sync_state` to force a resync.** Deleting sync state triggers full historical re-ingestion and can create duplicate entitlement records.
- **Recovery Mode**: Run `node scripts/run-stellar-indexer.mjs recover` under IC supervision.

---

## 3. Executable Recovery Checks

EduVault provides executable, non-destructive recovery verification in `src/lib/ops/incidentRecoveryChecks.js` and via CLI:

```bash
# Execute recovery checks offline (kill switches and signer cap validation)
node scripts/incident-recovery-checks.mjs --dry-run

# Execute full suite against MongoDB (audit ledger, dead-letter, indexer sync)
MONGODB_URI="$URI" node scripts/incident-recovery-checks.mjs
```

### Registered Executable Checks

1. **`refund_signing_kill_switch`**: Verifies whether emergency containment is engaged or available.
2. **`refund_signer_cap_enforcement`**: Evaluates `assertWithinSignerLimit` against over-cap amounts.
3. **`audit_ledger_integrity`**: Cryptographically re-computes SHA-256 hash chains across audit records to ensure no tamper or missing sequence.
4. **`dead_letter_backpressure`**: Evaluates pending dead-letter count against alert thresholds (default $\le 20$).
5. **`indexer_sync_lag`**: Calculates ledger distance between `sync_state.lastLedger` and current Stellar network sequence.

---

## 4. Operational Playbooks

### Playbook 1: Dead-Letter Queue Triage and Reprocessing
1. Inspect dead-letter backpressure:
   ```bash
   node scripts/indexer-deadletter.mjs list --status=retryable --limit=20
   ```
2. For transient failures (network timeout, rate limit), retry with operator authorization:
   ```bash
   node scripts/indexer-deadletter.mjs retry <event-id>
   ```
3. For permanently poisoned or schema-drifted events, quarantine with reason:
   ```bash
   node scripts/indexer-deadletter.mjs quarantine <event-id> --reason="Schema drift: missing required field"
   ```

### Playbook 2: Schema Drift Detection & Event Incompatibility
1. Run event drift detection across outbox / sync events:
   ```bash
   node scripts/detect-event-drift.mjs --dry-run
   ```
2. If breaking schema drift is detected from an upstream producer:
   - Quarantine invalid payloads to prevent worker crash loops.
   - Dispatch schema compatibility adapter or deploy producer hotfix.

### Playbook 3: Restore and Rollback Verification
1. Verify backup archive integrity before touching production:
   ```bash
   node scripts/verify-restore.mjs <backup-file.tar.gz>
   ```
2. Verify rollback status after application code revert:
   ```bash
   node scripts/verify-rollback.mjs
   ```
3. Rebuild derived caches (never alter canonical records directly):
   ```bash
   node scripts/rebuild-entitlement-cache.mjs
   ```

---

## 5. Security & Authorization Policy

- **Least Privilege**: Only accounts with `admin` or `operator` role can execute recovery actions or trigger remediation.
- **Audit Logging**: Every executed recovery command appends an immutable entry to `incident_recovery_audit` recording `{ action, actor, timestamp, reason }`.
- **Zero-Secret Terminal Policy**: Never output JWTs, private keys, or raw connection strings to terminal logs or ticket channels.


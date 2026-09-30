# Incident triage and emergency rollback runbook

This runbook is for maintainers responding to a production incident in
EduVault's Next.js marketplace, MongoDB catalog, Pinata/IPFS storage, and
Stellar/Soroban integration. It deliberately uses environment-variable names,
redacted identifiers, and placeholders: **never paste cookies, bearer tokens,
JWTs, database URIs, wallet seed phrases, webhook secrets, or signed download
URLs into tickets, chat, terminal history, or this document.**

Use the least-privileged production role needed for the action. A second
maintainer must review any production database write, contract deployment,
refund approval, or public recovery statement.

## 1. First 15 minutes: declare, contain, preserve

### Roles and severity

| Severity | Examples | Incident commander (IC) action | Update cadence |
| --- | --- | --- | --- |
| SEV-1 | Unauthorized access, protected-content exposure, incorrect settlement/refund signing, broad purchase or download outage | Page the security/deployment owner, stop the unsafe path, and open an incident channel immediately. | Every 30 minutes until mitigated. |
| SEV-2 | Publishing or checkout degraded, indexer stopped, IPFS provider outage, material data corruption limited to a cohort | Assign an IC and an operations owner; mitigate before normal release work continues. | Every 60 minutes. |
| SEV-3 | Individual creator/buyer record issue, retryable worker failure, non-critical dashboard error | Create a tracked incident, assign an owner, and repair during the next operational window. | At handoff and resolution. |

1. **Declare the incident.** Record UTC start time, reporter, severity, release/commit SHA, deployment URL, affected workflow, known affected material/purchase IDs, and the IC. Use IDs and hashes rather than student names, email addresses, wallet secrets, or file URLs.
2. **Freeze unrelated deploys and migrations.** The IC decides whether the suspected release can remain live. Do not run destructive repair scripts while evidence is still being collected.
3. **Contain first.** Choose the narrowest safe control in the decision table below. If protected content, wallet authority, or payments may be compromised, treat it as SEV-1 and stop the relevant path before diagnosing it.
4. **Preserve evidence.** Save redacted Sentry event links, deployment IDs, request IDs, transaction hashes, timestamps, and relevant audit entries in the incident record. Do not export raw database documents or request headers into public channels.
5. **Establish a baseline.** Capture the health and indexer responses below before applying a mitigation, then repeat the same checks after it.

### Safe baseline commands

Set the URL locally; do not put authentication values on the command line. For
an authenticated endpoint, use an approved secret manager or an authenticated
browser session, and redact the output before sharing it.

```bash
export EDUVAULT_URL="https://<production-host>"

# Dependency health: MongoDB, Pinata, email, and Stellar/Horizon/RPC.
curl --fail-with-body --silent --show-error "$EDUVAULT_URL/api/health" | jq .

# Indexer cursor, checkpoint time, dead-letter counts, and fork signals.
# This endpoint may require the configured indexer authorization.
curl --fail-with-body --silent --show-error "$EDUVAULT_URL/api/indexer" | jq .

# Local code and configuration validation; never substitute production secrets.
npm run lint
npm run test:frontend
npm run test:integration
```

If `/api/health` returns `503`, identify the failed service in `services` rather
than retrying blindly. If indexer authorization is enabled, a `401` means the
operator needs authorized access; it is not evidence that the indexer itself is
down.

## 2. Dashboards, signals, and decision points

Open these views at incident declaration and add their redacted links to the
incident record:

| Dashboard or source | What to inspect | Decision point |
| --- | --- | --- |
| Deployment provider deployment/activity view | First bad deployment, build logs, route error rate, rollback target | If errors begin immediately after one release, roll the app back before changing data. |
| Sentry issue and performance views | New exception fingerprint, affected release, request volume, client/server scope | Escalate to SEV-1 for auth/access or payment failures; otherwise correlate with a dependency or deployment. |
| `GET /api/health` | `database`, `pinata`, `email`, and `stellar` service states | A single dependency failure calls for provider/failover mitigation, not an application rollback by default. |
| Maintainer health dashboard (`GET /api/admin/health-dashboard`) | Outbox failures, dead letters, refunds, quarantine, stale intents, storage jobs, entitlement drift, access denials | A growing queue or drift count requires pausing the matching side effect and reconciling before declaring recovery. |
| `GET /api/indexer` and the indexer health fields | Cursor freshness, retryable/failed dead letters, fork rewinds | Quarantine poison events; recover missing events rather than replaying all transactions manually. |
| Pinata/provider console and storage integrity reports | Pin availability, gateway errors, quota/replication failures | Keep protected downloads fail-closed; repair/repin verified CIDs before re-enabling affected access. |
| Stellar explorer/RPC and transaction hashes | Transaction finality, fee spikes, contract event results | Never infer settlement from the UI alone; reconcile against canonical chain results. |

For the admin dashboard, use its normal authenticated UI/session rather than
recording an admin token in a shell command. A local, redacted report is also
available to an authorized operator:

```bash
# Run only in an approved environment with MONGODB_URI supplied by secret management.
node scripts/maintainer-health-report.mjs

# Inspect retryable indexer failures before acting on a specific event.
node scripts/indexer-deadletter.mjs list --status=retryable --limit=20
```

## 3. Category playbooks

### A. Access control or protected-download incident (SEV-1)

**Signals:** a Sentry authorization error spike, reports of another student's
content being accessible, unexpected `GET /api/download` successes, or a
suspected capability/JWT disclosure.

1. IC stops the affected download or entitlement release path by rolling back
   the application deployment if it introduced the exposure. Do not make
   protected objects public as a workaround: protected storage is expected to
   fail closed.
2. Security owner assesses scope using redacted access/audit records and the
   affected material/purchase IDs. Preserve request IDs and timestamps.
3. Verify owner/entitlement checks with the existing route and access tests:

   ```bash
   npm run test:integration -- --run test/integration/access.test.js
   npm run test:frontend -- --run src/lib/downloads/__tests__/accessLog.test.js
   ```

4. Rotate a potentially exposed signing/session secret through the deployment
   platform's secret manager and redeploy. Coordinate the rotation because it
   can invalidate active sessions or download capabilities.
5. Restore access only after an authorized test buyer can access their own
   material and an unauthorized test buyer is denied. Notify affected students
   privately if the incident process determines disclosure is required.

### B. Checkout, refund, or settlement incident (SEV-1/SEV-2)

**Signals:** duplicate/failed settlement, refund queue growth, incorrect amount
or recipient, signing errors, or a Stellar RPC outage.

1. If automatic refunds could sign an unsafe transaction, set the deployment
   environment variable `REFUND_SIGNING_DISABLED=true` and redeploy. This is a
   fail-closed emergency kill switch for refund signing; it intentionally
   blocks automatic refund execution.
2. Do not retry, refund, or edit purchase records until the operations owner
   has correlated each affected `purchaseId` with a transaction hash and the
   canonical chain result.
3. Inspect failed/retryable work in the health dashboard. For a suspected
   indexer gap, use the documented recovery mode instead of manually inserting
   events:

   ```bash
   # Requires approved runtime configuration; it does not need or print a secret key.
   node scripts/run-stellar-indexer.mjs recover
   node scripts/rebuild-entitlement-cache.mjs
   ```

4. Re-enable signing only after a second maintainer reviews the affected
   purchase list, the transaction outcomes, and the configured transaction cap.
   Validate the kill switch behavior and workflow protections locally:

   ```bash
   npm run test:frontend -- --run src/lib/stellar/__tests__/refundSigner.test.js
   npm run test:frontend -- --run src/lib/refunds/__tests__/refundWorkflow.test.js
   ```

### C. Storage, upload, or IPFS integrity incident (SEV-2)

**Signals:** upload failures, Pinata authentication/gateway errors, quota alert,
missing CIDs, content hash mismatch, or an infected/quarantined upload.

1. Use `/api/health` and the provider dashboard to distinguish a provider
   outage from an application regression. If a release caused upload failures,
   roll it back; otherwise leave existing immutable records untouched.
2. Keep affected material unpublished/quarantined and do not replace a CID in
   place. Student ownership and purchase receipts depend on stable historical
   references.
3. Run the integrity checker in its reporting mode first, then follow the
   storage recovery procedure for only verified affected CIDs:

   ```bash
   node scripts/check-ipfs-integrity.mjs --help
   npm run test:frontend -- --run src/lib/storage
   ```

4. Confirm content can be retrieved from the configured gateway and any
   secondary provider without weakening protected-content access checks. Record
   CIDs/hashes, not file contents, in the incident record.

### D. Indexer, webhook, or asynchronous-work incident (SEV-2)

**Signals:** stale cursor, growing dead letters/outbox, webhook signature
errors, missing purchase entitlements, or a recent fork rewind.

1. Compare `updatedAt`, `lastLedger`, dead-letter counts, and
   `lastForkRewindAt` from `/api/indexer` against the Stellar explorer/RPC.
2. Retry only events classified as retryable. Quarantine malformed/poison
   events with a reason; every operator action is audited:

   ```bash
   node scripts/indexer-deadletter.mjs list --status=retryable --limit=20
   node scripts/indexer-deadletter.mjs retry <event-id>
   node scripts/indexer-deadletter.mjs quarantine <event-id> --reason="<redacted reason>"
   ```

3. For a cursor gap or fork recovery, run `node scripts/run-stellar-indexer.mjs
   recover` once under the IC's change record. Do not delete `sync_state` to
   force a resync.
4. Verify repaired records with the indexer tests and entitlement-cache report:

   ```bash
   npm run test:frontend -- --run src/lib/indexer/__tests__
   node scripts/rebuild-entitlement-cache.mjs
   ```

### E. MongoDB data integrity, outage, or migration incident (SEV-1/SEV-2)

**Signals:** database health failure, elevated route 5xx responses, duplicate or
missing catalog records, migration failure, or invalid access state.

1. Stop migrations and writes that could amplify corruption. Determine whether
   the failure is connectivity, schema/index, or incorrect application logic.
2. Before any restore, take a fresh backup/evidence snapshot according to the
   deployment recovery procedure. Restore only to an isolated environment
   first; do not point a recovery test at production traffic.
3. Validate the candidate recovery with the repository's verification tooling:

   ```bash
   node scripts/restore-verification.mjs <backup-archive.gz>
   node scripts/rebuild-entitlement-cache.mjs
   ```

4. Reconcile catalog, purchases, and entitlement cache before reopening
   checkout/downloads. A database restore cannot reverse a finalized chain
   transaction; handle any mismatch through the payment/reconciliation process.

## 4. Emergency rollback path for risky releases

Risky releases include changes to authentication or authorization, upload and
protected storage, purchase/refund paths, contract IDs or WASM, webhooks,
indexer event parsing, database migrations, and any change that can create an
irreversible chain side effect.

### Decision tree

1. **Is there active unauthorized access or unsafe signing?** Stop that path
   immediately (for automatic refunds, set `REFUND_SIGNING_DISABLED=true` and
   redeploy), declare SEV-1, then roll back the application if the release is
   implicated.
2. **Did errors begin after a single application deployment and no irreversible
   side effect has occurred?** Roll back the application to the last known-good
   deployment.
3. **Did the release include a migration or chain action?** Do **not** blindly
   roll back data or contracts. Freeze the workflow, identify affected IDs and
   transactions, restore/reconcile using the relevant playbook, and obtain
   second-maintainer approval for any compensating action.
4. **Is a dependency unavailable but the release is healthy?** Prefer provider
   failover/retry and fail-closed behavior. Do not roll back a healthy release
   merely to mask a provider incident.

### Application rollback procedure

1. IC records the target deployment/commit and the reason for rollback.
2. In the deployment provider console, promote the last known-good production
   deployment. If the repository's Vercel workflow is being used, the equivalent
   command is:

   ```bash
   npx vercel rollback
   ```

   Alternatively, redeploy the approved previous commit through the normal CI
   pipeline. Do not use a local checkout containing unreviewed changes to make
   a production rollback.
3. Confirm the deployment has the prior commit and expected environment
   configuration. Do not print or copy environment values during this check.
4. Run the post-rollback validation checklist below. Keep the incident open if
   errors persist, queue depth grows, or reconciliation finds discrepancies.

### Soroban/contract rollback guardrail

On-chain operations may be final and contract upgrades require the authorized
upgrade process. Do not assume an application rollback undoes a contract call,
payment, entitlement, or published IPFS content. For a faulty contract release:

1. Stop application traffic to the affected purchase/registration path and
   preserve transaction hashes.
2. Use the approved contract administration procedure to deploy the reviewed
   prior WASM/version or a forward-fix; update contract IDs/configuration only
   through approved deployment controls.
3. Reindex and reconcile impacted records and entitlements before re-enabling
   the path. Obtain second-maintainer approval and document the exact artifact
   hash and transaction hashes.

## 5. Recovery validation and communications

### Exit criteria

The IC may move an incident to monitoring only when all applicable checks pass:

- `/api/health` reports healthy, or the accepted dependency degradation is
  explicitly documented with its safe fallback.
- Sentry error rate has returned to baseline for at least one normal traffic
  interval and no new matching critical event is appearing.
- Indexer cursor/checkpoint advances; no unresolved poison dead letter remains;
  any fork rewind has been reviewed.
- A representative creator can publish only when uploads are enabled, an
  authorized buyer can access their entitled material, and an unauthorized buyer
  is denied.
- Every affected purchase/refund has a recorded canonical transaction outcome;
  entitlement-cache verification reports no mismatch (or an approved exception
  list is attached).
- The deployment/provider dashboard shows the intended release and no growing
  outbox, quarantine, storage-job, or stale-intent backlog.

Run the normal smoke test after the deployment is stable, using secret-managed
configuration and saving only its redacted output/transaction hashes with the
incident record:

```bash
bash scripts/smoke-test.sh
npm run lint
npm run test:frontend
npm run test:integration
```

### Status updates

Use factual, student-safe language. The IC owns external updates; responders
must not speculate about root cause, identify another student's records, or
publish internal credentials/URLs.

| Moment | Minimum update |
| --- | --- |
| Initial | Acknowledge the affected feature, when investigation started (UTC), current mitigation, and next update time. |
| During recovery | State what is restored/disabled, whether purchases or access are affected, and the next update time. Do not claim payment finality until reconciled. |
| Resolved | State the user-visible impact window, recovery verification completed, any safe user action required, and a link/contact for affected students. |
| Follow-up | Within five business days, record timeline, root cause, impact count/range, mitigations, reconciliation outcome, and preventive actions. Keep private security details in the restricted incident record. |

## Related operational references

- [Deployment and backup recovery](deployment.md)
- [Maintainer operational health dashboard](MAINTAINER_OPERATIONAL_HEALTH.md)
- [Indexer observability and dead-letter operations](indexer-observability.md)
- [Storage integrity and recovery](storage-integrity-and-recovery.md)
- [Refund custody controls](refund-custody.md)
- [Disaster recovery](disaster-recovery.md)

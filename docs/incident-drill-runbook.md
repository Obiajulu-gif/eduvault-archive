# Incident drill runbook

`docs/incident-triage-runbook.md` tells a maintainer what to do *during* a
real incident. It has never been rehearsed end-to-end as a group exercise,
so a safety mechanism it depends on — a kill switch, a per-transaction cap,
a self-approval guard, the audit chain, a restored backup's invariants — can
silently regress and nobody finds out until a real incident needs it.

This runbook is the drill: a scheduled, non-destructive exercise that runs
the *actual* safety mechanisms against synthetic or read-only inputs and
reports PASS/FAIL, instead of asking someone to re-read a checklist and
imagine it still works.

**Nothing in this drill mutates production configuration, signs a real
transaction, or writes to the database.** Every check either calls a pure
guard function with synthetic inputs, or only reads a live database when one
is supplied. See `src/lib/ops/incidentDrill.js` for exactly what each check
does and does not touch.

## Cadence

Run this drill at least monthly, and after any change to:
`src/lib/stellar/refundSigner.js`, `src/lib/approvals/maintainerApprovalFlow.js`,
`src/lib/backend/auditLedger.js`, `src/lib/ops/restoreVerification.js`,
`scripts/data-retention-cleanup.mjs`, or `scripts/data-minimization-review.mjs`.

## Running the drill

```bash
# Offline drills only (no database required, nothing to configure):
node scripts/incident-drill.mjs

# Offline + database-backed drills (read-only):
MONGODB_URI="$URI" node scripts/incident-drill.mjs

# Persist a report for the incident/drill record:
MONGODB_URI="$URI" node scripts/incident-drill.mjs --report-json ./incident-drill.json
```

Exit code is non-zero if any check `FAIL`s. A `SKIPPED` database check is not
a failure by itself — but repeated SKIPs mean the drill is only exercising
half of the registry; schedule a run with `MONGODB_URI` set against a
staging/replica database.

## What each check rehearses

| Check (`id`) | Rehearses | Maps to triage runbook section |
| --- | --- | --- |
| `refund_signer_cap` | `assertWithinSignerLimit` actually blocks an over-cap refund amount and allows an in-cap one. | B. Checkout, refund, or settlement incident |
| `refund_kill_switch_state` | Reads whether `REFUND_SIGNING_DISABLED` is currently engaged (informational — never flips it). | B. Checkout, refund, or settlement incident |
| `approval_flow_self_approval_guard` | A maintainer cannot approve their own proposed action, and a genuinely different, correctly-signed approver is accepted. Uses a throwaway in-memory Stellar keypair. | — (gates any high-impact maintainer action; see `docs/maintainer-approval-flow.md`) |
| `audit_ledger_integrity` | The hash-chained `audit_ledger` still verifies from sequence 0 with no gaps. Read-only. | E. MongoDB data integrity, outage, or migration incident |
| `restore_invariants` | Entitlement/search derived-view reconciliation, required indexes, and the audit chain — reuses `runRestoreVerification`. Read-only. | E. MongoDB data integrity, outage, or migration incident |
| `data_retention_preview` (companion script) | `data-retention-cleanup.mjs --preview` performs zero writes and `buckets.failed` is empty. Read-only. | — (see `docs/data-retention-policy.md`) |
| `data_minimization_review` (companion script) | No operational metadata collection has drifted to carry an undocumented field. Read-only. | — (see `docs/data-retention-policy.md`) |

## Reading a FAIL

A `FAIL` means the mechanism itself is broken *right now*, independent of
whether a real incident is happening — treat it as a regression to fix
before the next release, not something to wait out:

1. **`refund_signer_cap` FAIL** — the signer-layer cap no longer blocks an
   over-cap amount, or now wrongly blocks a valid one. Check
   `REFUND_MAX_AMOUNT_PER_TX` and `src/lib/stellar/refundSigner.js` for a
   regression before the next refund is processed.
2. **`approval_flow_self_approval_guard` FAIL** — either self-approval is no
   longer rejected (a maintainer could approve their own high-impact
   action) or a genuine signature is being wrongly rejected. Treat the
   former as a security regression: block merges until fixed.
3. **`audit_ledger_integrity` / `restore_invariants` FAIL** — follow
   "E. MongoDB data integrity..." in `docs/incident-triage-runbook.md`
   immediately; these are the same invariants a real restore depends on.
4. **Companion script FAIL** — follow the remediation in
   `docs/data-retention-policy.md` (`buckets.failed`) or investigate the
   flagged collection's writer code for the minimization review.

## References

- Implementation: `src/lib/ops/incidentDrill.js`, `scripts/incident-drill.mjs`
- Reactive procedure this drill rehearses: `docs/incident-triage-runbook.md`
- Related: `docs/maintainer-approval-flow.md`, `docs/data-retention-policy.md`,
  `docs/restore-invariant-verification.md`

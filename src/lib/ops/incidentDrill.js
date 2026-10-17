import { Keypair } from "@stellar/stellar-sdk";
import crypto from "node:crypto";
import {
  assertWithinSignerLimit,
  getRefundSignerMaxAmount,
  isRefundSigningEnabled,
} from "../stellar/refundSigner.js";
import {
  createApprovalIntent,
  getApprovalSigningMessage,
  createSignedReceipt,
  verifyApprovalSignature,
} from "../approvals/maintainerApprovalFlow.js";
import { readAuditRecords, verifyAuditRecords } from "../backend/auditLedger.js";
import { runRestoreVerification } from "./restoreVerification.js";

/**
 * Incident drill runbook, backed by executable checks (#948).
 *
 * `docs/incident-triage-runbook.md` tells a maintainer what to do *during* a
 * real incident. It has never been rehearsed end-to-end, so a procedure can
 * silently rot — a kill switch that no longer works, a cap that got removed,
 * a self-approval guard that regressed — and nobody finds out until a real
 * incident needs it.
 *
 * This module is the drill: each registered scenario exercises the actual
 * safety mechanism (not a description of it) and reports PASS/FAIL/SKIPPED,
 * mirroring the shape of `src/lib/release/releaseReadiness.js`. Scenarios
 * that need a database degrade to SKIPPED without one, so the drill can
 * always run offline for the checks that don't.
 *
 * Nothing here mutates production configuration (no env var is ever
 * flipped) or signs a real transaction — every check either calls a pure
 * guard function with synthetic inputs, or reads (never writes) a live
 * database when one is supplied.
 */

export const DrillStatus = Object.freeze({
  PASSED: "PASSED",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
});

/**
 * Drill: the refund signer's per-transaction cap actually blocks an
 * over-cap amount and actually allows an in-cap amount. Exercises
 * `assertWithinSignerLimit` from `src/lib/stellar/refundSigner.js` with
 * synthetic amounts — no real transaction is built or signed.
 */
export function drillRefundSignerCap() {
  const max = getRefundSignerMaxAmount();
  if (!Number.isFinite(max)) {
    return {
      id: "refund_signer_cap",
      status: DrillStatus.SKIPPED,
      message: "REFUND_MAX_AMOUNT_PER_TX is not configured (cap is Infinity); nothing to drill.",
    };
  }

  const overCap = max + 1;
  const inCap = Math.max(0.0000001, max / 2);

  let blockedOverCap = false;
  try {
    assertWithinSignerLimit(overCap);
  } catch {
    blockedOverCap = true;
  }

  let allowedInCap = true;
  try {
    assertWithinSignerLimit(inCap);
  } catch {
    allowedInCap = false;
  }

  const ok = blockedOverCap && allowedInCap;
  return {
    id: "refund_signer_cap",
    status: ok ? DrillStatus.PASSED : DrillStatus.FAILED,
    message: ok
      ? `Signer cap enforced: blocked ${overCap} (over cap ${max}), allowed ${inCap} (in cap).`
      : `Signer cap NOT enforced correctly: blockedOverCap=${blockedOverCap}, allowedInCap=${allowedInCap}.`,
    details: { max, overCap, inCap, blockedOverCap, allowedInCap },
  };
}

/**
 * Drill: informational read of the refund signing kill switch
 * (`REFUND_SIGNING_DISABLED`). Never flips it — flipping a production kill
 * switch belongs to an incident commander during a real drill/incident, not
 * to an unattended check.
 */
export function drillRefundKillSwitchState({ env = process.env } = {}) {
  const enabled = env.REFUND_SIGNING_DISABLED !== "true";
  return {
    id: "refund_kill_switch_state",
    status: DrillStatus.PASSED,
    message: enabled
      ? "Refund signing is currently ENABLED. Kill switch is available (REFUND_SIGNING_DISABLED=true) but not engaged."
      : "Refund signing is currently DISABLED via the kill switch. Confirm this is intentional before closing the drill.",
    details: { enabled },
  };
}

/**
 * Drill: the maintainer approval flow's self-approval guard actually
 * rejects a maintainer approving their own proposed action, and actually
 * accepts a genuinely different, correctly-signed approver. Uses a
 * throwaway Stellar keypair generated in-memory — no real maintainer
 * identity or production state is touched.
 */
export function drillApprovalFlowSelfApprovalGuard() {
  const proposer = Keypair.random();
  const approver = Keypair.random();

  const intent = createApprovalIntent({
    actionType: "INCIDENT_DRILL",
    actor: proposer.publicKey(),
    target: { type: "drill", id: "incident-drill-self-approval" },
    reason: "Executable incident drill check (#948) — not a real action.",
  });

  const digest = crypto.createHash("sha256").update(getApprovalSigningMessage(intent), "utf8").digest();

  let selfApprovalRejected = false;
  try {
    const selfSignature = proposer.sign(digest);
    createSignedReceipt({
      intent,
      approverAddress: proposer.publicKey(),
      signatureHex: selfSignature.toString("hex"),
      decision: "approved",
    });
  } catch {
    selfApprovalRejected = true;
  }

  const genuineSignature = approver.sign(digest);
  const genuineSignatureVerifies = verifyApprovalSignature({
    intent,
    approverAddress: approver.publicKey(),
    signatureHex: genuineSignature.toString("hex"),
  });

  let genuineApprovalAccepted = false;
  try {
    const receipt = createSignedReceipt({
      intent,
      approverAddress: approver.publicKey(),
      signatureHex: genuineSignature.toString("hex"),
      decision: "approved",
    });
    genuineApprovalAccepted = receipt.intentHash === intent.intentHash;
  } catch {
    genuineApprovalAccepted = false;
  }

  const ok = selfApprovalRejected && genuineSignatureVerifies && genuineApprovalAccepted;
  return {
    id: "approval_flow_self_approval_guard",
    status: ok ? DrillStatus.PASSED : DrillStatus.FAILED,
    message: ok
      ? "Self-approval was rejected and a genuine, differently-signed approval was accepted."
      : "Approval flow guard regressed — see details.",
    details: { selfApprovalRejected, genuineSignatureVerifies, genuineApprovalAccepted },
  };
}

/**
 * Drill: the audit ledger's hash chain still verifies end-to-end. Read-only.
 * Requires a database; SKIPPED without one.
 */
export async function drillAuditLedgerIntegrity({ db, limit = 100_000 } = {}) {
  if (!db) {
    return { id: "audit_ledger_integrity", status: DrillStatus.SKIPPED, message: "No database supplied." };
  }
  const records = await readAuditRecords(db, { limit });
  const result = verifyAuditRecords(records);
  return {
    id: "audit_ledger_integrity",
    status: result.valid ? DrillStatus.PASSED : DrillStatus.FAILED,
    message: result.valid
      ? `Audit chain verified across ${records.length} record(s).`
      : `Audit chain broken at sequence ${result.brokenAtSequence}.`,
    details: { recordCount: records.length, brokenAtSequence: result.brokenAtSequence ?? null },
  };
}

/**
 * Drill: the restore-verification invariants (entitlement/search
 * derived-view reconciliation, required indexes, audit chain) all hold
 * against the current database. Read-only — reuses
 * `src/lib/ops/restoreVerification.js` (#889/#...) rather than duplicating
 * its logic. Requires a database; SKIPPED without one.
 */
export async function drillRestoreInvariants({ db, options = {} } = {}) {
  if (!db) {
    return { id: "restore_invariants", status: DrillStatus.SKIPPED, message: "No database supplied." };
  }
  const result = await runRestoreVerification({ db, options });
  return {
    id: "restore_invariants",
    status: result.ok ? DrillStatus.PASSED : DrillStatus.FAILED,
    message: result.ok
      ? "Entitlement/search derived views, required indexes, and the audit chain all verified."
      : `${result.violationCount} restore invariant violation(s) found.`,
    details: { violationCount: result.violationCount, repairSteps: result.repairSteps },
  };
}

/** Registry of drills that don't require a database. */
export const OFFLINE_DRILLS = Object.freeze([
  drillRefundSignerCap,
  drillRefundKillSwitchState,
  drillApprovalFlowSelfApprovalGuard,
]);

/** Registry of drills that read (never write) a live database. */
export const DATABASE_DRILLS = Object.freeze([drillAuditLedgerIntegrity, drillRestoreInvariants]);

/**
 * Runs every registered drill and returns a release-readiness-shaped
 * report. `db` is optional: database drills report SKIPPED without one so
 * the offline drills can always run safely, anywhere.
 */
export async function runIncidentDrill({ db = null, env = process.env } = {}) {
  const results = [
    ...OFFLINE_DRILLS.map((fn) => fn({ env })),
    ...(await Promise.all(DATABASE_DRILLS.map((fn) => fn({ db })))),
  ];

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === DrillStatus.PASSED).length,
    failed: results.filter((r) => r.status === DrillStatus.FAILED).length,
    skipped: results.filter((r) => r.status === DrillStatus.SKIPPED).length,
  };

  return {
    ranAt: new Date().toISOString(),
    ok: summary.failed === 0,
    summary,
    results,
  };
}

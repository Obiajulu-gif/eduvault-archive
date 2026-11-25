import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DETERMINISTIC_EVIDENCE_SCHEMA_VERSION,
  buildDeterministicDisputeEvidenceBundle,
  verifyDeterministicDisputeEvidenceBundle,
  authorizeDisputeEvidenceAction,
  attachDeterministicEvidenceBundle,
  rollbackDeterministicEvidenceBundle,
} from '../../src/lib/refunds/deterministicEvidenceBundle.js';
import { DISPUTE_STATUS } from '../../src/lib/refunds/disputeWorkflow.js';

const BUNDLE_KEY = 'deterministic-dispute-evidence-key-0123456789';
const BUYER_ADDR = 'GBUYERADDRESS12345678901234567890123456789012';
const CREATOR_ADDR = 'GCREATORADDRESS12345678901234567890123456789012';
const OTHER_ADDR = 'GOTHERADDRESS123456789012345678901234567890123';

function getNestedValue(obj, path) {
  return path.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

function createMockDb(initialDisputes = []) {
  const disputes = initialDisputes.map((d) => structuredClone(d));
  return {
    collection(name) {
      assert.equal(name, 'disputes');
      return {
        async findOne(query) {
          return (
            disputes.find((item) =>
              Object.entries(query).every(([key, expected]) => {
                const actual = key.includes('.') ? getNestedValue(item, key) : item[key];
                return String(actual) === String(expected);
              })
            ) || null
          );
        },
        async findOneAndUpdate(query, update) {
          const item = await this.findOne(query);
          if (!item) return null;
          if (update.$set) {
            Object.assign(item, structuredClone(update.$set));
          }
          if (update.$push) {
            for (const [key, val] of Object.entries(update.$push)) {
              if (!Array.isArray(item[key])) item[key] = [];
              item[key].push(structuredClone(val));
            }
          }
          return structuredClone(item);
        },
      };
    },
  };
}

function makeEvidenceBundle() {
  return {
    buyerClaim: {
      reason: '  Content   incomplete ',
      description: 'Video module 3 missing downloadable assets',
      submittedAt: '2026-08-30T00:00:00Z',
    },
    creatorMetadata: {
      materialId: 'mat_react_101',
      title: 'Advanced React Course',
      version: '1.2.0',
      creatorAddress: CREATOR_ADDR,
    },
    purchaseTransaction: {
      transactionHash: '0xabc123def4567890',
      amount: 150.0,
      assetCode: 'usdc',
      purchasedAt: '2026-08-25T12:00:00.000Z',
    },
    accessLogs: [
      { timestamp: '2026-08-25T12:10:00.000Z', action: 'download_attempt', status: 'missing_file' },
      { timestamp: '2026-08-25T12:05:00.000Z', action: 'stream_start', status: 'ok' },
    ],
    entitlementState: {
      active: true,
      grantedAt: '2026-08-25T12:00:00.000Z',
    },
  };
}

describe('Deterministic Refund Dispute Evidence Bundles', () => {
  describe('Normal path: determinism, canonicalization, and verification', () => {
    it('produces identical bundleId and bundleDigest regardless of key order, log order, duplicates, or formatting', () => {
      const bundleA = buildDeterministicDisputeEvidenceBundle({
        purchaseId: 'purch_1001',
        disputeId: 'disp_1001',
        evidenceBundle: makeEvidenceBundle(),
        bundleKey: BUNDLE_KEY,
      });

      // Reordered keys, reversed + duplicated access logs, numeric string amount, uppercase/whitespace differences
      const reorderedEvidence = {
        entitlementState: {
          grantedAt: new Date('2026-08-25T12:00:00.000Z'),
          active: true,
        },
        accessLogs: [
          { status: 'OK', action: 'STREAM_START', timestamp: '2026-08-25T12:05:00Z' },
          { status: 'missing_file', action: 'download_attempt', timestamp: '2026-08-25T12:10:00.000Z' },
          { status: 'missing_file', action: 'download_attempt', timestamp: '2026-08-25T12:10:00Z' }, // duplicate
        ],
        purchaseTransaction: {
          assetCode: ' USDC ',
          amount: '150.00',
          purchasedAt: '2026-08-25T12:00:00Z',
          transactionHash: '0xabc123def4567890',
        },
        creatorMetadata: {
          version: '1.2.0',
          creatorAddress: CREATOR_ADDR,
          title: 'Advanced React Course',
          materialId: 'mat_react_101',
        },
        buyerClaim: {
          submittedAt: '2026-08-30T00:00:00.000Z',
          description: 'Video module 3 missing downloadable assets',
          reason: 'Content incomplete',
        },
      };

      const bundleB = buildDeterministicDisputeEvidenceBundle({
        purchaseId: 'purch_1001',
        disputeId: 'disp_1001',
        evidenceBundle: reorderedEvidence,
        bundleKey: BUNDLE_KEY,
      });

      assert.equal(bundleA.ok, true);
      assert.equal(bundleB.ok, true);
      assert.equal(bundleA.bundle.schemaVersion, DETERMINISTIC_EVIDENCE_SCHEMA_VERSION);
      assert.equal(bundleA.bundle.bundleId, bundleB.bundle.bundleId);
      assert.equal(bundleA.bundle.bundleDigest, bundleB.bundle.bundleDigest);
      assert.deepEqual(bundleA.bundle.sectionDigests, bundleB.bundle.sectionDigests);
      assert.deepEqual(bundleA.bundle.provenanceSeal, bundleB.bundle.provenanceSeal);
      assert.equal(bundleB.bundle.sections.accessLogs.length, 2);

      const verification = verifyDeterministicDisputeEvidenceBundle(bundleA.bundle, {
        bundleKey: BUNDLE_KEY,
      });
      assert.deepEqual(verification, { valid: true, errors: [] });
    });
  });

  describe('Failure paths: validation, tampering, and state locks', () => {
    it('rejects incomplete evidence bundles', () => {
      const res = buildDeterministicDisputeEvidenceBundle({
        purchaseId: 'purch_bad',
        evidenceBundle: { buyerClaim: { reason: 'broken' } },
      });
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'incomplete_evidence_bundle');
      assert.ok(res.errors.includes('missing_buyer_claim_submitted_at'));
      assert.ok(res.errors.includes('missing_creator_metadata'));
    });

    it('rejects weak bundleKey for provenance sealing', () => {
      const res = buildDeterministicDisputeEvidenceBundle({
        purchaseId: 'purch_1001',
        evidenceBundle: makeEvidenceBundle(),
        bundleKey: 'too-short',
      });
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'invalid_bundle_key');
    });

    it('detects tampering in sections, digests, and provenance seal', () => {
      const built = buildDeterministicDisputeEvidenceBundle({
        purchaseId: 'purch_1001',
        evidenceBundle: makeEvidenceBundle(),
        bundleKey: BUNDLE_KEY,
      });
      const tampered = structuredClone(built.bundle);
      tampered.sections.purchaseTransaction.amount = 9999;

      const verifyRes = verifyDeterministicDisputeEvidenceBundle(tampered, {
        bundleKey: BUNDLE_KEY,
      });
      assert.equal(verifyRes.valid, false);
      assert.ok(verifyRes.errors.includes('section_digest_mismatch:purchaseTransaction'));
      assert.ok(verifyRes.errors.includes('bundle_digest_mismatch'));
      assert.ok(verifyRes.errors.includes('bundle_id_mismatch'));
      assert.ok(verifyRes.errors.includes('provenance_signature_mismatch'));
    });

    it('rejects attaching evidence to locked (approved/denied/executed) disputes', async () => {
      const db = createMockDb([
        {
          _id: 'disp_locked',
          purchaseId: 'purch_locked',
          buyerAddress: BUYER_ADDR,
          status: DISPUTE_STATUS.APPROVED,
          evidenceBundle: makeEvidenceBundle(),
          history: [],
        },
      ]);

      const res = await attachDeterministicEvidenceBundle({
        db,
        disputeId: 'disp_locked',
        evidenceBundle: makeEvidenceBundle(),
        actor: { id: 'admin_1', role: 'admin' },
      });
      assert.equal(res.success, false);
      assert.equal(res.statusCode, 409);
      assert.equal(res.reason, 'dispute_evidence_locked');
    });
  });

  describe('Retry paths: idempotency, conflict detection, and admin supersede', () => {
    let db;

    beforeEach(() => {
      db = createMockDb([
        {
          _id: 'disp_retry_1',
          purchaseId: 'purch_retry_1',
          buyerAddress: BUYER_ADDR,
          status: DISPUTE_STATUS.OPENED,
          evidenceBundle: makeEvidenceBundle(),
          history: [],
        },
      ]);
    });

    it('treats identical reordered retry as idempotent without duplicating history', async () => {
      const first = await attachDeterministicEvidenceBundle({
        db,
        disputeId: 'disp_retry_1',
        evidenceBundle: makeEvidenceBundle(),
        actor: { id: BUYER_ADDR, address: BUYER_ADDR, role: 'buyer' },
        bundleKey: BUNDLE_KEY,
      });
      assert.equal(first.success, true);
      assert.equal(first.idempotent, false);
      assert.equal(first.dispute.history.length, 1);

      // Retry with reversed access logs (semantically identical)
      const retryPayload = makeEvidenceBundle();
      retryPayload.accessLogs.reverse();

      const second = await attachDeterministicEvidenceBundle({
        db,
        disputeId: 'disp_retry_1',
        evidenceBundle: retryPayload,
        actor: { id: BUYER_ADDR, address: BUYER_ADDR, role: 'buyer' },
        bundleKey: BUNDLE_KEY,
      });
      assert.equal(second.success, true);
      assert.equal(second.idempotent, true);
      assert.equal(second.bundle.bundleDigest, first.bundle.bundleDigest);
      assert.equal(second.dispute.history.length, 1);
    });

    it('rejects conflicting evidence retry unless admin/reviewer explicitly supersedes', async () => {
      await attachDeterministicEvidenceBundle({
        db,
        disputeId: 'disp_retry_1',
        evidenceBundle: makeEvidenceBundle(),
        actor: { id: 'reviewer_1', role: 'reviewer' },
      });

      const modified = makeEvidenceBundle();
      modified.buyerClaim.reason = 'Updated claim reason';

      const conflict = await attachDeterministicEvidenceBundle({
        db,
        disputeId: 'disp_retry_1',
        evidenceBundle: modified,
        actor: { id: 'reviewer_1', role: 'reviewer' },
      });
      assert.equal(conflict.success, false);
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.reason, 'evidence_bundle_conflict');

      const superseded = await attachDeterministicEvidenceBundle({
        db,
        disputeId: 'disp_retry_1',
        evidenceBundle: modified,
        actor: { id: 'reviewer_1', role: 'reviewer' },
        allowSupersede: true,
      });
      assert.equal(superseded.success, true);
      assert.equal(superseded.idempotent, false);
      assert.equal(superseded.dispute.deterministicEvidence.revision, 2);
      assert.ok(superseded.dispute.deterministicEvidence.previousSnapshot);
    });
  });

  describe('Authorization paths', () => {
    const dispute = {
      _id: 'disp_auth',
      purchaseId: 'purch_auth',
      buyerAddress: BUYER_ADDR,
      status: DISPUTE_STATUS.OPENED,
      evidenceBundle: makeEvidenceBundle(),
    };

    it('rejects unauthenticated actors with 401', () => {
      const res = authorizeDisputeEvidenceAction({ actor: null, action: 'read', dispute });
      assert.equal(res.authorized, false);
      assert.equal(res.statusCode, 401);
    });

    it('enforces role and ownership boundaries for read, attach, and rollback', () => {
      // Unrelated user cannot read or attach
      assert.equal(
        authorizeDisputeEvidenceAction({
          actor: { address: OTHER_ADDR, role: 'buyer' },
          action: 'read',
          dispute,
        }).statusCode,
        403
      );

      // Creator can read but cannot attach
      assert.equal(
        authorizeDisputeEvidenceAction({
          actor: { address: CREATOR_ADDR, role: 'creator' },
          action: 'read',
          dispute,
        }).authorized,
        true
      );
      assert.equal(
        authorizeDisputeEvidenceAction({
          actor: { address: CREATOR_ADDR, role: 'creator' },
          action: 'attach',
          dispute,
        }).statusCode,
        403
      );

      // Buyer can attach while opened, but not once reviewing
      assert.equal(
        authorizeDisputeEvidenceAction({
          actor: { address: BUYER_ADDR, role: 'buyer' },
          action: 'attach',
          dispute,
        }).authorized,
        true
      );
      assert.equal(
        authorizeDisputeEvidenceAction({
          actor: { address: BUYER_ADDR, role: 'buyer' },
          action: 'attach',
          dispute: { ...dispute, status: DISPUTE_STATUS.REVIEWING },
        }).statusCode,
        403
      );

      // Only admin can rollback
      assert.equal(
        authorizeDisputeEvidenceAction({
          actor: { id: 'rev_1', role: 'reviewer' },
          action: 'rollback',
          dispute,
        }).statusCode,
        403
      );
      assert.equal(
        authorizeDisputeEvidenceAction({
          actor: { id: 'adm_1', role: 'admin' },
          action: 'rollback',
          dispute,
        }).authorized,
        true
      );
    });
  });

  describe('Recovery and rollback paths', () => {
    it('allows admin to roll back a superseded bundle to the previous snapshot', async () => {
      const db = createMockDb([
        {
          _id: 'disp_rb_1',
          purchaseId: 'purch_rb_1',
          buyerAddress: BUYER_ADDR,
          status: DISPUTE_STATUS.REVIEWING,
          evidenceBundle: makeEvidenceBundle(),
          history: [],
        },
      ]);

      const v1 = await attachDeterministicEvidenceBundle({
        db,
        disputeId: 'disp_rb_1',
        evidenceBundle: makeEvidenceBundle(),
        actor: { id: 'admin_1', role: 'admin' },
      });

      const v2Payload = makeEvidenceBundle();
      v2Payload.buyerClaim.reason = 'Erroneous update';
      const v2 = await attachDeterministicEvidenceBundle({
        db,
        disputeId: 'disp_rb_1',
        evidenceBundle: v2Payload,
        actor: { id: 'admin_1', role: 'admin' },
        allowSupersede: true,
      });

      const rb = await rollbackDeterministicEvidenceBundle({
        db,
        disputeId: 'disp_rb_1',
        actor: { id: 'admin_1', role: 'admin' },
        reason: 'Reverting mistaken reviewer edit',
      });

      assert.equal(rb.success, true);
      assert.equal(rb.rolledBackBundleId, v2.bundle.bundleId);
      assert.equal(rb.restoredBundleId, v1.bundle.bundleId);
      assert.equal(rb.dispute.deterministicEvidence.bundleDigest, v1.bundle.bundleDigest);
      assert.equal(rb.dispute.history.at(-1).action, 'evidence_bundle_rolled_back');
    });

    it('blocks rollback on executed disputes', async () => {
      const db = createMockDb([
        {
          _id: 'disp_exec',
          purchaseId: 'purch_exec',
          buyerAddress: BUYER_ADDR,
          status: DISPUTE_STATUS.EXECUTED,
          evidenceBundle: makeEvidenceBundle(),
          deterministicEvidence: { bundleId: 'rdeb_123', bundleDigest: 'abc', revision: 1 },
          history: [],
        },
      ]);

      const rb = await rollbackDeterministicEvidenceBundle({
        db,
        disputeId: 'disp_exec',
        actor: { id: 'admin_1', role: 'admin' },
      });

      assert.equal(rb.success, false);
      assert.equal(rb.statusCode, 409);
      assert.equal(rb.reason, 'cannot_rollback_executed_dispute');
    });
  });
});

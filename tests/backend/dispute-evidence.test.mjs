import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPUTE_STATUS,
  validateEvidenceBundle,
  openDispute,
  transitionDisputeStatus,
  executeDisputeRefund,
} from '../../src/lib/refunds/disputeWorkflow.js';

// In-memory collection helper mock
function createMockDb() {
  const store = new Map();
  return {
    collection(name) {
      if (!store.has(name)) store.set(name, []);
      const items = store.get(name);
      return {
        async findOne(query) {
          return items.find(item => {
            for (const key of Object.keys(query)) {
              if (key === '_id') {
                if (String(item._id) !== String(query._id)) return false;
              } else if (key === 'status' && typeof query.status === 'object' && query.status.$in) {
                if (!query.status.$in.includes(item.status)) return false;
              } else if (item[key] !== query[key]) {
                return false;
              }
            }
            return true;
          }) || null;
        },
        async insertOne(doc) {
          const _id = doc._id || `id_${Math.random().toString(36).substr(2, 9)}`;
          const inserted = { ...doc, _id };
          items.push(inserted);
          return { insertedId: _id };
        },
        async findOneAndUpdate(query, update) {
          const item = await this.findOne(query);
          if (!item) return null;
          if (update.$set) {
            Object.assign(item, update.$set);
          }
          if (update.$push) {
            for (const key of Object.keys(update.$push)) {
              if (!item[key]) item[key] = [];
              item[key].push(update.$push[key]);
            }
          }
          return item;
        },
      };
    },
  };
}

const VALID_BUNDLE = {
  buyerClaim: {
    reason: 'Content incomplete',
    description: 'Video module 3 missing downloadable assets',
    submittedAt: '2026-08-30T00:00:00.000Z',
  },
  creatorMetadata: {
    materialId: 'mat_react_101',
    title: 'Advanced React Course',
    version: '1.2.0',
    creatorAddress: 'GCREATORADDRESS12345678901234567890123456789012',
  },
  purchaseTransaction: {
    transactionHash: '0xabc123def4567890',
    amount: 150.0,
    assetCode: 'USDC',
    purchasedAt: '2026-08-25T12:00:00.000Z',
  },
  accessLogs: [
    { timestamp: '2026-08-25T12:05:00.000Z', action: 'download_attempt', status: 'missing_file' },
  ],
  entitlementState: {
    active: true,
    grantedAt: '2026-08-25T12:00:00.000Z',
  },
};

describe('Refund Dispute Evidence Bundle & Workflow (#709)', () => {
  let db;

  beforeEach(() => {
    db = createMockDb();
  });

  it('validates complete evidence bundle correctly', () => {
    const res = validateEvidenceBundle(VALID_BUNDLE);
    assert.equal(res.valid, true);
    assert.equal(res.errors.length, 0);
  });

  it('rejects incomplete evidence bundle with missing fields', () => {
    const incomplete = {
      buyerClaim: { reason: 'Defective' }, // missing submittedAt
      creatorMetadata: { materialId: 'mat_1' }, // missing creatorAddress and version
      // missing purchaseTransaction, accessLogs, entitlementState
    };
    const res = validateEvidenceBundle(incomplete);
    assert.equal(res.valid, false);
    assert.ok(res.errors.includes('missing_buyer_claim_submitted_at'));
    assert.ok(res.errors.includes('missing_creator_address'));
    assert.ok(res.errors.includes('missing_purchase_transaction'));
    assert.ok(res.errors.includes('missing_access_logs'));
    assert.ok(res.errors.includes('missing_entitlement_state'));
  });

  it('opens a dispute when complete evidence bundle is provided', async () => {
    const res = await openDispute({
      db,
      purchaseId: 'purch_999',
      buyerAddress: 'GBUYERADDRESS12345678901234567890123456789012',
      reason: 'Content incomplete',
      evidenceBundle: VALID_BUNDLE,
      actor: 'GBUYERADDRESS12345678901234567890123456789012',
    });

    assert.equal(res.success, true);
    assert.equal(res.dispute.status, DISPUTE_STATUS.OPENED);
    assert.equal(res.dispute.purchaseId, 'purch_999');
    assert.deepEqual(res.dispute.evidenceBundle, VALID_BUNDLE);
  });

  it('rejects opening duplicate dispute for the same purchase', async () => {
    await openDispute({
      db,
      purchaseId: 'purch_duplicate_1',
      buyerAddress: 'GBUYER1',
      reason: 'First claim',
      evidenceBundle: VALID_BUNDLE,
    });

    const res = await openDispute({
      db,
      purchaseId: 'purch_duplicate_1',
      buyerAddress: 'GBUYER1',
      reason: 'Second claim',
      evidenceBundle: VALID_BUNDLE,
    });

    assert.equal(res.success, false);
    assert.equal(res.reason, 'duplicate_dispute');
  });

  it('handles status transitions: opened -> reviewing -> approved -> executed', async () => {
    const opened = await openDispute({
      db,
      purchaseId: 'purch_flow_1',
      buyerAddress: 'GBUYER1',
      reason: 'Access issue',
      evidenceBundle: VALID_BUNDLE,
    });
    const disputeId = opened.dispute._id;

    // 1. Move to reviewing
    const reviewing = await transitionDisputeStatus({
      db,
      disputeId,
      toStatus: DISPUTE_STATUS.REVIEWING,
      actor: 'admin_1',
      notes: 'Reviewing claim evidence',
    });
    assert.equal(reviewing.success, true);
    assert.equal(reviewing.dispute.status, DISPUTE_STATUS.REVIEWING);

    // 2. Move to approved
    const approved = await transitionDisputeStatus({
      db,
      disputeId,
      toStatus: DISPUTE_STATUS.APPROVED,
      actor: 'admin_1',
      notes: 'Approved claim',
    });
    assert.equal(approved.success, true);
    assert.equal(approved.dispute.status, DISPUTE_STATUS.APPROVED);

    // 3. Execute refund
    const executed = await executeDisputeRefund({
      db,
      disputeId,
      actor: 'admin_1',
      executeRefundFn: async () => ({ success: true, refundId: 'ref_executed_001' }),
    });
    assert.equal(executed.success, true);
    assert.equal(executed.dispute.status, DISPUTE_STATUS.EXECUTED);
  });

  it('handles status transition: opened -> reviewing -> denied', async () => {
    const opened = await openDispute({
      db,
      purchaseId: 'purch_denied_1',
      buyerAddress: 'GBUYER1',
      reason: 'Not satisfied',
      evidenceBundle: VALID_BUNDLE,
    });
    const disputeId = opened.dispute._id;

    await transitionDisputeStatus({
      db,
      disputeId,
      toStatus: DISPUTE_STATUS.REVIEWING,
      actor: 'admin_1',
    });

    const denied = await transitionDisputeStatus({
      db,
      disputeId,
      toStatus: DISPUTE_STATUS.DENIED,
      actor: 'admin_1',
      notes: 'Claim denied due to full course download',
    });

    assert.equal(denied.success, true);
    assert.equal(denied.dispute.status, DISPUTE_STATUS.DENIED);

    // Attempting to execute refund on denied dispute fails
    const execResult = await executeDisputeRefund({
      db,
      disputeId,
      actor: 'admin_1',
    });
    assert.equal(execResult.success, false);
    assert.equal(execResult.reason, 'refund_execution_requires_approved_dispute');
  });
});

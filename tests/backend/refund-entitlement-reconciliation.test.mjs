import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
import { createFakeCollection, createFakeDb } from '../../src/lib/refunds/__tests__/fakeMongo.js';
import {
  applyRefundEntitlementPlan,
  buildRefundEntitlementPlan,
  ENTITLEMENT_RECONCILIATIONS_COLLECTION,
  EntitlementReconciliationError,
} from '../../src/lib/refunds/entitlementReconciliation.js';

function makeContext(overrides = {}) {
  const purchase = {
    _id: new ObjectId(),
    materialId: 'mat-1173',
    buyerAddress: 'GBUYER1173',
    amount: '100',
    refundedAmount: 0,
    settlementState: null,
    ...overrides,
  };
  const refund = {
    _id: new ObjectId(),
    purchaseId: String(purchase._id),
    materialId: purchase.materialId,
    buyerAddress: purchase.buyerAddress,
    amount: Object.hasOwn(overrides, 'refundAmount') ? overrides.refundAmount : '100',
    txHash: 'refund-tx-1173',
  };
  delete refund.refundAmount;

  const collections = {
    purchases: createFakeCollection(),
    refunds: createFakeCollection(),
    [ENTITLEMENT_RECONCILIATIONS_COLLECTION]: createFakeCollection(),
  };
  const db = createFakeDb(collections);
  return { db, purchase, refund, collections };
}

async function seed(collections, purchase, refund) {
  await collections.purchases.insertOne({ ...purchase, appliedRefundIds: [] });
  await collections.refunds.insertOne({ ...refund, status: 'settled' });
}

describe('deterministic refund entitlement reconciliation (#1173)', () => {
  it('produces the same plan for identical trusted inputs', () => {
    const { purchase, refund } = makeContext();
    const first = buildRefundEntitlementPlan({ purchase, refund, generatedAt: '2026-11-23T00:00:00.000Z' });
    const second = buildRefundEntitlementPlan({ purchase, refund, generatedAt: '2026-11-23T00:00:00.000Z' });
    assert.deepEqual(first, second);
    assert.equal(first.action, 'revoke');
    assert.equal(first.settlementState, 'Refunded');
  });

  it('revokes access once on a full refund and replays without a second revocation', async () => {
    const { db, purchase, refund, collections } = makeContext();
    await seed(collections, purchase, refund);
    const plan = buildRefundEntitlementPlan({ purchase, refund });
    const revoked = [];

    const first = await applyRefundEntitlementPlan({
      db,
      plan,
      actor: 'system',
      allowSystem: true,
      revokeFn: async (materialId, buyer) => revoked.push(`${materialId}:${buyer}`),
    });
    const second = await applyRefundEntitlementPlan({
      db,
      plan,
      actor: 'system',
      allowSystem: true,
      revokeFn: async (materialId, buyer) => revoked.push(`${materialId}:${buyer}`),
    });

    assert.equal(first.outcome, 'applied');
    assert.equal(second.outcome, 'replayed');
    assert.deepEqual(revoked, ['mat-1173:GBUYER1173']);
    const storedPurchase = await collections.purchases.findOne({ _id: purchase._id });
    assert.equal(storedPurchase.refundedAmount, 100);
    assert.equal(storedPurchase.settlementState, 'Refunded');
    assert.deepEqual(storedPurchase.appliedRefundIds, [String(refund._id)]);
  });

  it('retains access for a partial refund but still mirrors the refund amount', async () => {
    const { db, purchase, refund, collections } = makeContext({ refundAmount: '40' });
    await seed(collections, purchase, refund);
    const plan = buildRefundEntitlementPlan({ purchase, refund });
    let revoked = false;

    const result = await applyRefundEntitlementPlan({
      db,
      plan,
      actor: { id: 'admin-1', role: 'admin' },
      revokeFn: async () => { revoked = true; },
    });

    assert.equal(result.plan.action, 'retain');
    assert.equal(revoked, false);
    const storedPurchase = await collections.purchases.findOne({ _id: purchase._id });
    assert.equal(storedPurchase.refundedAmount, 40);
    assert.equal(storedPurchase.settlementState, 'PartiallyRefunded');
    const storedRefund = await collections.refunds.findOne({ _id: refund._id });
    assert.equal(storedRefund.entitlementRevoked, false);
  });

  it('retries a failed revocation from the durable pending plan without double-counting', async () => {
    const { db, purchase, refund, collections } = makeContext();
    await seed(collections, purchase, refund);
    const plan = buildRefundEntitlementPlan({ purchase, refund });

    await assert.rejects(
      applyRefundEntitlementPlan({
        db,
        plan,
        actor: 'system',
        allowSystem: true,
        revokeFn: async () => { throw new Error('cache unavailable'); },
      }),
      /cache unavailable/
    );

    let revocations = 0;
    const result = await applyRefundEntitlementPlan({
      db,
      plan,
      actor: 'system',
      allowSystem: true,
      revokeFn: async () => { revocations += 1; },
    });

    assert.equal(result.outcome, 'applied');
    assert.equal(revocations, 1);
    const storedPurchase = await collections.purchases.findOne({ _id: purchase._id });
    assert.equal(storedPurchase.refundedAmount, 100);
  });

  it('rejects an unauthorized principal before any write', async () => {
    const { db, purchase, refund, collections } = makeContext();
    await seed(collections, purchase, refund);
    const plan = buildRefundEntitlementPlan({ purchase, refund });

    await assert.rejects(
      applyRefundEntitlementPlan({
        db,
        plan,
        actor: { id: 'buyer', role: 'user' },
        revokeFn: async () => {},
      }),
      (error) => error instanceof EntitlementReconciliationError && error.code === 'UNAUTHORIZED_RECONCILIATION'
    );
    assert.equal(collections[ENTITLEMENT_RECONCILIATIONS_COLLECTION].docs.length, 0);
  });

  it('uses cumulative refunds so a partial followed by a full refund revokes exactly once', () => {
    const { purchase, refund } = makeContext({ refundAmount: '60' });
    const plan = buildRefundEntitlementPlan({
      purchase: { ...purchase, refundedAmount: 40 },
      refund: { ...refund, amount: 60 },
    });
    assert.equal(plan.totalRefundedAmount, '100');
    assert.equal(plan.action, 'revoke');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeCollection, createFakeDb } from '../../src/lib/refunds/__tests__/fakeMongo.js';
import {
  PAYOUT_SETTLEMENT_RECONCILIATIONS_COLLECTION,
  SETTLEMENT_RECONCILIATION_VERSION,
  SettlementReconciliationError,
  buildSettlementReconciliation,
  reconcilePayoutSettlement,
  toMinorUnits,
} from '../../src/lib/payouts/settlementReconciliation.js';

const NOW = '2026-11-23T00:00:00.000Z';
const ADMIN = { id: 'admin-1176', role: 'admin' };

function makeContext({ payoutOverrides = {}, eventOverrides = {} } = {}) {
  const payout = {
    _id: 'payout-1176',
    payoutId: 'payout-1176',
    creatorAddress: 'GCREATOR1176',
    asset: 'USDC',
    amount: '25.00',
    network: 'stellar',
    txHash: 'settlement-tx-1176',
    status: 'pending',
    ...payoutOverrides,
  };

  const event = {
    eventId: 'settlement-event-1176',
    payoutId: 'payout-1176',
    creatorAddress: 'gcreator1176',
    asset: 'usdc',
    amount: '25000000',
    network: 'STELLAR',
    txHash: 'SETTLEMENT-TX-1176',
    eventType: 'payout.settled',
    occurredAt: NOW,
    ...eventOverrides,
  };

  const collections = {
    payouts: createFakeCollection(),
    [PAYOUT_SETTLEMENT_RECONCILIATIONS_COLLECTION]: createFakeCollection({
      uniqueKey: (doc) => (doc.kind === 'conflict' ? doc._id : doc.eventId),
    }),
  };
  const db = createFakeDb(collections);

  const journal = createFakeCollection({ uniqueKey: (doc) => doc.idempotencyKey });
  const journalEntries = [];
  const appendJournalEntryFn = async (entry) => {
    const idempotencyKey = `${entry.txnId}:${entry.asset}:${entry.debitAccount}:${entry.creditAccount}`;
    const existing = await journal.findOne({ idempotencyKey });
    if (existing) return existing;
    const stored = {
      ...entry,
      idempotencyKey,
      debit: { account: entry.debitAccount, amount: BigInt(entry.amount) },
      credit: { account: entry.creditAccount, amount: BigInt(entry.amount) },
    };
    await journal.insertOne(stored);
    journalEntries.push(stored);
    return stored;
  };

  const auditCollection = createFakeCollection({ uniqueKey: (doc) => doc.operationId });
  const audits = [];
  const recordAuditFn = async (audit) => {
    await auditCollection.insertOne({ ...audit, _id: audit.operationId });
    audits.push(audit);
    return audit;
  };

  const reconcile = (overrides = {}) => reconcilePayoutSettlement({
    db,
    event,
    actor: ADMIN,
    now: NOW,
    appendJournalEntryFn,
    recordAuditFn,
    ...overrides,
  });

  return { db, payout, event, collections, journal, journalEntries, audits, reconcile };
}

async function seedPayout(context) {
  await context.collections.payouts.insertOne(context.payout);
}

describe('payout settlement reconciliation (#1176)', () => {
  it('posts one balanced journal entry and an audit event for a matching settlement', async () => {
    const context = makeContext();
    await seedPayout(context);

    const result = await context.reconcile();

    assert.equal(result.outcome, 'applied');
    assert.equal(result.applied, true);
    assert.equal(result.plan.version, SETTLEMENT_RECONCILIATION_VERSION);
    assert.equal(result.plan.amountMinorUnits, '25000000');
    assert.deepEqual(result.discrepancies, []);

    assert.equal(context.journalEntries.length, 1);
    assert.equal(context.journalEntries[0].amount, 25000000n);
    assert.equal(context.journalEntries[0].debit.account, 'collaborator_payable');
    assert.equal(context.journalEntries[0].credit.account, 'sales_receivable');
    assert.equal(context.audits.length, 1);
    assert.equal(context.audits[0].result.status, 'posted');

    const stored = await context.collections[PAYOUT_SETTLEMENT_RECONCILIATIONS_COLLECTION].findOne({ _id: result.plan.planId });
    assert.equal(stored.status, 'applied');
    assert.equal(stored.eventId, context.event.eventId);
  });

  it('is a no-op when the same eventId is replayed', async () => {
    const context = makeContext();
    await seedPayout(context);

    const first = await context.reconcile();
    const second = await context.reconcile();

    assert.equal(first.outcome, 'applied');
    assert.equal(second.outcome, 'replayed');
    assert.equal(second.applied, false);
    assert.equal(second.plan.planId, first.plan.planId);
    assert.equal(context.journalEntries.length, 1);
    assert.equal(context.audits.length, 1);
    assert.equal(context.collections[PAYOUT_SETTLEMENT_RECONCILIATIONS_COLLECTION].docs.length, 1);
  });

  it('persists evidence for a duplicate eventId with conflicting payload', async () => {
    const context = makeContext();
    await seedPayout(context);

    const first = await context.reconcile();
    const conflictingEvent = { ...context.event, amount: '26000000' };
    const conflict = await context.reconcile({ event: conflictingEvent });

    assert.equal(first.outcome, 'applied');
    assert.equal(conflict.outcome, 'conflict');
    assert.equal(conflict.discrepancies[0].code, 'DUPLICATE_CONFLICT');
    assert.equal(conflict.discrepancies[0].expectedFingerprint, first.plan.eventFingerprint);
    assert.equal(conflict.discrepancies[0].actualFingerprint, conflict.plan.eventFingerprint);

    const conflicts = context.collections[PAYOUT_SETTLEMENT_RECONCILIATIONS_COLLECTION].docs.filter((doc) => doc.kind === 'conflict');
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].evidence.storedEvent.amountMinorUnits, '25000000');
    assert.equal(conflicts[0].evidence.incomingEvent.amountMinorUnits, '26000000');

    const replayedConflict = await context.reconcile({ event: conflictingEvent });
    assert.equal(replayedConflict.outcome, 'conflict_replayed');
    assert.equal(context.collections[PAYOUT_SETTLEMENT_RECONCILIATIONS_COLLECTION].docs.filter((doc) => doc.kind === 'conflict').length, 1);
    assert.equal(context.journalEntries.length, 1);
    assert.equal(context.audits.length, 2);
  });

  it('records an amount mismatch as a discrepancy without posting a settlement', async () => {
    const context = makeContext({ payoutOverrides: { amount: '24.99' } });
    await seedPayout(context);

    const result = await context.reconcile();

    assert.equal(result.outcome, 'discrepancy');
    assert.equal(result.applied, false);
    const mismatch = result.discrepancies.find((item) => item.code === 'AMOUNT_MISMATCH');
    assert.ok(mismatch);
    assert.equal(mismatch.expectedMinorUnits, '24990000');
    assert.equal(mismatch.actualMinorUnits, '25000000');
    assert.equal(context.journalEntries.length, 0);
    assert.equal(context.audits.length, 1);
    assert.equal(context.audits[0].eventType, 'payout_settlement_discrepancy');

    const stored = await context.collections[PAYOUT_SETTLEMENT_RECONCILIATIONS_COLLECTION].findOne({ _id: result.plan.planId });
    assert.equal(stored.status, 'discrepancy');
    assert.equal(stored.discrepancies[0].code, 'AMOUNT_MISMATCH');
  });

  it('rejects an unauthorized actor before any write', async () => {
    const context = makeContext();
    await seedPayout(context);

    await assert.rejects(
      context.reconcile({ actor: { id: 'creator', role: 'user' } }),
      (error) => error instanceof SettlementReconciliationError && error.code === 'UNAUTHORIZED_RECONCILIATION'
    );

    assert.equal(context.collections[PAYOUT_SETTLEMENT_RECONCILIATIONS_COLLECTION].docs.length, 0);
    assert.equal(context.journalEntries.length, 0);
    assert.equal(context.audits.length, 0);
  });

  it('converts integer minor units and decimal strings without floating-point math', () => {
    assert.equal(toMinorUnits(25000000n), 25000000n);
    assert.equal(toMinorUnits(25000000), 25000000n);
    assert.equal(toMinorUnits('25000000'), 25000000n);
    assert.equal(toMinorUnits('25.00'), 25000000n);
    assert.equal(toMinorUnits('25.000001'), 25000001n);

    assert.throws(
      () => toMinorUnits('25.0000001'),
      (error) => error instanceof SettlementReconciliationError && error.code === 'AMOUNT_PRECISION_UNSUPPORTED'
    );
    assert.throws(
      () => toMinorUnits(Number.MAX_SAFE_INTEGER + 1),
      (error) => error instanceof SettlementReconciliationError && error.code === 'UNSAFE_AMOUNT'
    );

    const context = makeContext();
    const numericPlan = buildSettlementReconciliation({
      event: { ...context.event, amount: 25000000 },
      generatedAt: NOW,
    });
    const stringPlan = buildSettlementReconciliation({ event: context.event, generatedAt: NOW });

    assert.equal(numericPlan.amountMinorUnits, stringPlan.amountMinorUnits);
    assert.equal(numericPlan.planId, stringPlan.planId);
    assert.equal(numericPlan.idempotencyKey, stringPlan.idempotencyKey);
    assert.equal(numericPlan.journal.txnId, stringPlan.journal.txnId);
  });
});

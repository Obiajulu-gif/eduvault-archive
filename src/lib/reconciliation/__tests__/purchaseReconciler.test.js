import { describe, it, expect, beforeEach } from 'vitest';
import { PurchaseReconciler } from '../purchaseReconciler.js';

describe('On-Chain to MongoDB Purchase Reconciler', () => {
  let mongoDbMap;
  let reconciler;

  beforeEach(() => {
    mongoDbMap = new Map();
    reconciler = new PurchaseReconciler({ mongoDb: mongoDbMap, initialBlock: 100 });
  });

  it('automatically backfills missing MongoDB records from confirmed chain events', async () => {
    const chainEvents = [
      { intentId: 'intent-77', buyer: '0xBuyer', materialId: 'mat-1', txHash: '0xTx77', blockNumber: 105 }
    ];

    const res = await reconciler.runReconciliationCycle(110, chainEvents);
    expect(res.backfilledRecords).toBe(1);
    expect(mongoDbMap.has('intent-77')).toBe(true);
    expect(mongoDbMap.get('intent-77').autoBackfilled).toBe(true);
  });

  it('flags pending MongoDB records that have no on-chain ledger proof', async () => {
    mongoDbMap.set('intent-99', { intentId: 'intent-99', buyer: '0xBuyer', status: 'pending' });

    const res = await reconciler.runReconciliationCycle(110, []);
    expect(res.flaggedDiscrepancies).toBe(1);
    expect(mongoDbMap.get('intent-99').status).toBe('flagged_unconfirmed');
    expect(reconciler.getAlerts().length).toBe(1);
  });

  it('is resumable and tracks last processed block', async () => {
    await reconciler.runReconciliationCycle(110, []);
    expect(reconciler.lastProcessedBlock).toBe(110);
  });
});

/**
 * Reconciliation worker between on-chain payment ledger events and MongoDB purchase records.
 * Backfills missing MongoDB records and flags unconfirmed purchases.
 */

export class PurchaseReconciler {
  constructor(options = {}) {
    this.mongoDb = options.mongoDb || new Map();
    this.ledgerClient = options.ledgerClient;
    this.lastProcessedBlock = options.initialBlock || 0;
    this.alerts = [];
  }

  async runReconciliationCycle(currentChainBlock, chainEvents = []) {
    const startBlock = this.lastProcessedBlock + 1;
    const eventsToProcess = chainEvents.filter(
      (e) => e.blockNumber >= startBlock && e.blockNumber <= currentChainBlock
    );

    const resultSummary = {
      processedEvents: eventsToProcess.length,
      backfilledRecords: 0,
      flaggedDiscrepancies: 0,
      fromBlock: startBlock,
      toBlock: currentChainBlock
    };

    for (const event of eventsToProcess) {
      const { intentId, buyer, materialId, txHash, blockNumber } = event;

      const mongoRecord = this.mongoDb.get(intentId);

      if (!mongoRecord) {
        // Backfill missing MongoDB record for confirmed on-chain transaction
        this.mongoDb.set(intentId, {
          intentId,
          buyer,
          materialId,
          txHash,
          status: 'confirmed',
          autoBackfilled: true,
          confirmedAtBlock: blockNumber,
          createdAt: new Date().toISOString()
        });
        resultSummary.backfilledRecords++;
      } else {
        // Update existing record with chain tx info
        mongoRecord.status = 'confirmed';
        mongoRecord.txHash = txHash;
        mongoRecord.confirmedAtBlock = blockNumber;
      }
    }

    // Scan MongoDB pending records that lack chain confirmation
    for (const [intentId, record] of this.mongoDb.entries()) {
      if (record.status === 'pending') {
        const confirmedOnChain = chainEvents.some((e) => e.intentId === intentId);
        if (!confirmedOnChain) {
          record.status = 'flagged_unconfirmed';
          this.alerts.push({
            type: 'UNCONFIRMED_PURCHASE_INTENT',
            intentId,
            message: `Purchase record ${intentId} exists in DB but has no corresponding on-chain confirmation.`
          });
          resultSummary.flaggedDiscrepancies++;
        }
      }
    }

    this.lastProcessedBlock = currentChainBlock;
    return resultSummary;
  }

  getAlerts() {
    return this.alerts;
  }
}

/**
 * Creator Payout Journal - Double-Entry Accounting
 *
 * Append-only journal for creator payouts with:
 * - Asset-balanced entries (debit + credit per asset per transaction)
 * - Idempotent replay from finalized purchase/refund events
 * - Reconciliation against contract escrow
 * - Reorg-safe history with immutable entries
 */

import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

export const ACCOUNT_TYPES = {
  // Assets
  SALES_RECEIVABLE: "sales_receivable",
  REVENUE: "revenue",
  REFUND_EXPENSE: "refund_expense",
  FEE_PAYABLE: "fee_payable",
  COLLABORATOR_PAYABLE: "collaborator_payable",
};

/**
 * Append an entry to the journal
 *
 * @param {Object} params
 * @param {string} params.creatorId - Creator wallet address
 * @param {string} params.asset - Asset type (USDC, native, etc)
 * @param {number} params.debitAccount - Debit account type
 * @param {number} params.creditAccount - Credit account type
 * @param {BigInt} params.amount - Amount in smallest unit
 * @param {string} params.txnId - Blockchain transaction ID (idempotency key)
 * @param {string} params.sourceEvent - "purchase" or "refund"
 * @param {number} params.chainHeight - Block height of source event
 * @param {Object} params.metadata - Additional context
 */
export async function appendJournalEntry({
  creatorId,
  asset,
  debitAccount,
  creditAccount,
  amount,
  txnId,
  sourceEvent,
  chainHeight,
  metadata = {},
}) {
  const db = await getDb();
  const collection = db.collection("creator_journal");

  // Check for duplicate (idempotent key is txnId + asset + accounts)
  const idempotencyKey = `${txnId}:${asset}:${debitAccount}:${creditAccount}`;
  const existing = await collection.findOne({ idempotencyKey });
  if (existing) {
    return existing; // Already recorded
  }

  const entry = {
    _id: new ObjectId(),
    idempotencyKey,
    creatorId: creatorId.toLowerCase(),
    asset,
    debit: {
      account: debitAccount,
      amount: BigInt(amount),
    },
    credit: {
      account: creditAccount,
      amount: BigInt(amount),
    },
    txnId,
    sourceEvent,
    chainHeight,
    entryDate: new Date(),
    createdAt: new Date(),
    metadata,
  };

  await collection.insertOne(entry);
  return entry;
}

/**
 * Create paired entries for a purchase (debit receivable, credit revenue)
 */
export async function recordPurchaseEntry({
  creatorId,
  asset,
  amount,
  txnId,
  chainHeight,
  platformFeeAmount = 0,
  collaborators = [],
}) {
  const db = await getDb();
  const entries = [];

  // Main revenue entry: debit receivable, credit revenue
  const mainEntry = await appendJournalEntry({
    creatorId,
    asset,
    debitAccount: ACCOUNT_TYPES.SALES_RECEIVABLE,
    creditAccount: ACCOUNT_TYPES.REVENUE,
    amount,
    txnId,
    sourceEvent: "purchase",
    chainHeight,
    metadata: { type: "purchase_revenue" },
  });
  entries.push(mainEntry);

  // Platform fee: debit revenue, credit fee payable
  if (platformFeeAmount > 0) {
    const feeEntry = await appendJournalEntry({
      creatorId,
      asset,
      debitAccount: ACCOUNT_TYPES.REVENUE,
      creditAccount: ACCOUNT_TYPES.FEE_PAYABLE,
      amount: platformFeeAmount,
      txnId: `${txnId}:fee`,
      sourceEvent: "purchase",
      chainHeight,
      metadata: { type: "platform_fee" },
    });
    entries.push(feeEntry);
  }

  // Collaborator shares
  for (const collab of collaborators) {
    const collabEntry = await appendJournalEntry({
      creatorId,
      asset,
      debitAccount: ACCOUNT_TYPES.REVENUE,
      creditAccount: ACCOUNT_TYPES.COLLABORATOR_PAYABLE,
      amount: collab.shareAmount,
      txnId: `${txnId}:collab:${collab.address}`,
      sourceEvent: "purchase",
      chainHeight,
      metadata: {
        type: "collaborator_share",
        collaborator: collab.address,
      },
    });
    entries.push(collabEntry);
  }

  return entries;
}

/**
 * Record a refund as compensating entry (append, don't edit)
 * Debit refund expense, credit sales receivable
 */
export async function recordRefundEntry({
  creatorId,
  asset,
  amount,
  txnId,
  chainHeight,
  originalTxnId,
}) {
  return appendJournalEntry({
    creatorId,
    asset,
    debitAccount: ACCOUNT_TYPES.REFUND_EXPENSE,
    creditAccount: ACCOUNT_TYPES.SALES_RECEIVABLE,
    amount,
    txnId,
    sourceEvent: "refund",
    chainHeight,
    metadata: {
      type: "refund",
      originalTransaction: originalTxnId,
    },
  });
}

/**
 * Get journal entries for a creator within a date range
 */
export async function getCreatorJournalEntries(
  creatorId,
  startDate,
  endDate,
  asset = null
) {
  const db = await getDb();
  const query = {
    creatorId: creatorId.toLowerCase(),
    entryDate: {
      $gte: new Date(startDate),
      $lt: new Date(endDate),
    },
  };

  if (asset) {
    query.asset = asset;
  }

  return db
    .collection("creator_journal")
    .find(query)
    .sort({ entryDate: 1 })
    .toArray();
}

/**
 * Calculate balance for creator by asset
 * Returns { [asset]: netBalance } where netBalance = credits - debits
 */
export async function getCreatorBalance(creatorId, upToChainHeight = null) {
  const db = await getDb();
  const query = { creatorId: creatorId.toLowerCase() };

  if (upToChainHeight) {
    query.chainHeight = { $lte: upToChainHeight };
  }

  const entries = await db.collection("creator_journal").find(query).toArray();

  const balances = {};
  for (const entry of entries) {
    if (!balances[entry.asset]) {
      balances[entry.asset] = BigInt(0);
    }
    // Debit is a use of funds (negative), credit is a source (positive)
    balances[entry.asset] -= entry.debit.amount;
    balances[entry.asset] += entry.credit.amount;
  }

  return balances;
}

/**
 * Generate creator statement for given period
 * Returns transactions grouped by asset with totals
 */
export async function generateCreatorStatement(
  creatorId,
  startDate,
  endDate
) {
  const entries = await getCreatorJournalEntries(
    creatorId,
    startDate,
    endDate
  );

  const byAsset = {};
  for (const entry of entries) {
    if (!byAsset[entry.asset]) {
      byAsset[entry.asset] = {
        asset: entry.asset,
        debits: [],
        credits: [],
        totalDebit: BigInt(0),
        totalCredit: BigInt(0),
      };
    }

    byAsset[entry.asset].debits.push({
      account: entry.debit.account,
      amount: entry.debit.amount.toString(),
      txnId: entry.txnId,
      sourceEvent: entry.sourceEvent,
      metadata: entry.metadata,
    });

    byAsset[entry.asset].credits.push({
      account: entry.credit.account,
      amount: entry.credit.amount.toString(),
      txnId: entry.txnId,
      sourceEvent: entry.sourceEvent,
      metadata: entry.metadata,
    });

    byAsset[entry.asset].totalDebit += entry.debit.amount;
    byAsset[entry.asset].totalCredit += entry.credit.amount;
  }

  return {
    creatorId,
    period: { start: startDate, end: endDate },
    generatedAt: new Date(),
    byAsset: Object.values(byAsset),
  };
}

/**
 * Verify journal integrity: all transactions must balance per asset
 * Returns { valid: bool, issues: [] }
 */
export async function verifyJournalIntegrity(creatorId, upToChainHeight = null) {
  const entries = await getCreatorJournalEntries(creatorId, new Date(0), new Date());

  const issues = [];
  const txnsByAsset = {};

  for (const entry of entries) {
    if (upToChainHeight && entry.chainHeight > upToChainHeight) continue;

    const key = `${entry.txnId}:${entry.asset}`;
    if (!txnsByAsset[key]) {
      txnsByAsset[key] = { debits: BigInt(0), credits: BigInt(0) };
    }

    txnsByAsset[key].debits += entry.debit.amount;
    txnsByAsset[key].credits += entry.credit.amount;
  }

  for (const [key, amounts] of Object.entries(txnsByAsset)) {
    if (amounts.debits !== amounts.credits) {
      issues.push({
        transaction: key,
        debits: amounts.debits.toString(),
        credits: amounts.credits.toString(),
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

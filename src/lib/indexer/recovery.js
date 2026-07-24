import { withFailover } from '@/lib/stellar/horizonClient';
import { applyIndexedEvent } from '@/lib/indexer/stellarIndexer';
import { COLLECTIONS } from '@/lib/backend/schemaContracts';
import { isCompletedPurchaseStatus } from '@/lib/purchases/access';
import logger from '@/lib/logger';

const DEFAULT_LOOKBACK_LEDGERS = Number(process.env.RECOVERY_LOOKBACK_LEDGERS || 200);
const DEFAULT_ACCOUNT = process.env.STELLAR_ADMIN_PUBLIC_KEY || '';

/**
 * Purchases carry a transaction hash under one of two field names depending on
 * which path wrote the row: the checkout/access path writes `transactionHash`
 * (see `createPendingAccessRequest`), the indexer writes `chainTxHash`. Recovery
 * has to consult both. Checking only `chainTxHash` made every purchase settled
 * through the app look unindexed, which is what drove recovery to re-create
 * rows that already existed.
 */
function txHashQuery(hashes) {
  return {
    $or: [{ chainTxHash: { $in: hashes } }, { transactionHash: { $in: hashes } }],
  };
}

function hashesOf(purchase) {
  return [purchase?.chainTxHash, purchase?.transactionHash].filter(Boolean);
}

/**
 * Fetch recent payment operations for `accountId` from Horizon and return
 * only those that do not already correspond to a settled purchase.
 *
 * Only inbound payments are considered. `payments().forAccount()` returns both
 * directions, and treating an outbound one as a purchase would record the
 * platform account as the buyer of a refund it had just issued.
 *
 * @param {object} params
 * @param {import('mongodb').Db} params.db
 * @param {string} params.accountId   - Stellar G-address to audit
 * @param {number} [params.limit]     - Maximum Horizon records to scan
 * @returns {Promise<Array<object>>}  - Horizon payment records with no settled purchase
 */
export async function findMissingTransactions({ db, accountId, limit = 200 }) {
  if (!accountId) throw new Error('findMissingTransactions: accountId is required');

  const operations = await withFailover((server) =>
    server
      .payments()
      .forAccount(accountId)
      .limit(limit)
      .order('desc')
      .call()
  );

  const records = operations?.records ?? [];

  const inbound = records.filter(
    (op) => op.transaction_hash && (!op.to || op.to === accountId)
  );

  if (inbound.length === 0) return [];

  const onChainHashes = inbound.map((op) => op.transaction_hash);

  const existing = await db
    .collection(COLLECTIONS.purchases)
    .find(txHashQuery(onChainHashes), {
      projection: { chainTxHash: 1, transactionHash: 1, status: 1 },
    })
    .toArray();

  // Only a *completed* purchase counts as reconciled. A pending row that never
  // got settled is precisely the gap recovery exists to close.
  const settled = new Set(
    existing
      .filter((doc) => isCompletedPurchaseStatus(doc.status))
      .flatMap(hashesOf)
  );

  const missing = inbound.filter((op) => !settled.has(op.transaction_hash));

  logger.info(
    {
      accountId,
      scanned: records.length,
      inbound: inbound.length,
      alreadySettled: settled.size,
      missing: missing.length,
    },
    'Recovery audit complete'
  );

  return missing;
}

/**
 * Find the purchase a Horizon payment belongs to.
 *
 * A payment operation carries no material identity of its own, so the purchase
 * row is the only thing that can supply `materialId`. Without one there is
 * nothing safe to project.
 */
export async function findPurchaseForOperation(db, op) {
  return db
    .collection(COLLECTIONS.purchases)
    .findOne(txHashQuery([op.transaction_hash]));
}

/**
 * Convert a Horizon payment operation plus its owning purchase into the
 * normalised event shape expected by `applyIndexedEvent`.
 */
function operationToEvent(op, purchase) {
  return {
    id: op.transaction_hash,
    type: 'purchase.completed',
    materialId: purchase.materialId,
    // Horizon's JS operation records carry no top-level ledger field; the
    // previous `op.ledger_attr` read was always undefined. The transaction is
    // only present when the caller joined it, so this stays best-effort.
    ledger: op.transaction_attr?.ledger ?? null,
    transactionHash: op.transaction_hash,
    buyerAddress: purchase.buyerAddress || op.from,
    sellerAddress: purchase.sellerAddress || op.to,
    amount: op.amount ?? purchase.amount ?? null,
    asset: op.asset_code || 'XLM',
    source: 'recovery',
  };
}

/**
 * Re-process a list of Horizon payment records into the database.
 *
 * Recovery reconciles; it does not invent. An operation that cannot be matched
 * to a purchase is reported as an orphan rather than written, because the only
 * projection we could build from it would be a purchase and an entitlement with
 * no `materialId` — which grants the buyer access to a material that does not
 * exist and collapses every such recovery onto one row via the
 * `entitlements_buyer_material_unique` index.
 *
 * @param {object} params
 * @param {import('mongodb').Db} params.db
 * @param {Array<object>} params.operations
 * @returns {Promise<{recovered: number, skipped: number, orphaned: Array<object>, errors: string[]}>}
 */
export async function reprocessMissingTransactions({ db, operations }) {
  let recovered = 0;
  let skipped = 0;
  const orphaned = [];
  const errors = [];

  for (const op of operations) {
    let purchase;
    try {
      purchase = await findPurchaseForOperation(db, op);
    } catch (err) {
      errors.push(`${op.transaction_hash}: ${err.message}`);
      continue;
    }

    if (!purchase || !purchase.materialId) {
      orphaned.push({
        transactionHash: op.transaction_hash,
        from: op.from,
        to: op.to,
        amount: op.amount,
        reason: purchase ? 'purchase-missing-material-id' : 'no-matching-purchase',
      });
      logger.warn(
        { txHash: op.transaction_hash, from: op.from, amount: op.amount },
        'Recovery: on-chain payment has no reconcilable purchase; needs manual review'
      );
      continue;
    }

    try {
      const result = await applyIndexedEvent(db, operationToEvent(op, purchase));
      if (result.skipped) {
        skipped += 1;
      } else {
        recovered += 1;
        logger.info({ txHash: op.transaction_hash, materialId: purchase.materialId }, 'Recovery: transaction re-indexed');
      }
    } catch (err) {
      errors.push(`${op.transaction_hash}: ${err.message}`);
      logger.error({ txHash: op.transaction_hash, err: err.message }, 'Recovery: failed to re-index transaction');
    }
  }

  return { recovered, skipped, orphaned, errors };
}

/**
 * Full recovery run: audit Horizon against the database, then re-index any
 * payment that maps to a known but unsettled purchase.  Safe to run repeatedly
 * — duplicate-write protection is handled inside `applyIndexedEvent`.
 *
 * @param {object} params
 * @param {import('mongodb').Db} params.db
 * @param {string} [params.accountId]  - Stellar address to audit (defaults to STELLAR_ADMIN_PUBLIC_KEY)
 * @param {number} [params.limit]      - Horizon scan limit
 * @returns {Promise<{recovered: number, skipped: number, orphaned: Array<object>, errors: string[]}>}
 */
export async function runRecovery({ db, accountId = DEFAULT_ACCOUNT, limit = DEFAULT_LOOKBACK_LEDGERS }) {
  logger.info({ accountId, limit }, 'Starting Stellar indexer recovery run');

  const missing = await findMissingTransactions({ db, accountId, limit });

  if (missing.length === 0) {
    logger.info('Recovery: no missing transactions found');
    return { recovered: 0, skipped: 0, orphaned: [], errors: [] };
  }

  const result = await reprocessMissingTransactions({ db, operations: missing });

  logger.info(
    { ...result, orphaned: result.orphaned.length },
    'Recovery run complete'
  );
  return result;
}

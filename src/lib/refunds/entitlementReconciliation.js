import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';

export const ENTITLEMENT_RECONCILIATION_VERSION = '2026.11.1';
export const ENTITLEMENT_RECONCILIATIONS_COLLECTION = 'entitlement_reconciliations';

const MINOR_UNIT_SCALE = 1_000_000n;

export class EntitlementReconciliationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EntitlementReconciliationError';
    this.code = code;
  }
}

function canonicalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function toMinorUnits(value) {
  if (value === null || value === undefined || value === '') return 0n;
  const text = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
    throw new EntitlementReconciliationError('INVALID_AMOUNT', `Invalid monetary amount: ${text}`);
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > 6) {
    throw new EntitlementReconciliationError('AMOUNT_PRECISION_UNSUPPORTED', 'Amounts support at most 6 decimal places');
  }
  const scaled = BigInt(whole) * MINOR_UNIT_SCALE + BigInt(fraction.padEnd(6, '0') || '0');
  return negative ? -scaled : scaled;
}

function amountString(minorUnits) {
  const negative = minorUnits < 0n;
  const absolute = negative ? -minorUnits : minorUnits;
  const whole = absolute / MINOR_UNIT_SCALE;
  const fraction = (absolute % MINOR_UNIT_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole || '0'}${fraction ? `.${fraction}` : ''}`;
}

export const fallbackCollections = new WeakMap();

function getCollection(db, name) {
  const collection = db.collection(name);
  if (collection) return collection;

  let collections = fallbackCollections.get(db);
  if (!collections) {
    collections = new Map();
    fallbackCollections.set(db, collections);
  }
  if (collections.has(name)) return collections.get(name);

  const docs = new Map();
  const fallback = {
    async findOne(query = {}) {
      if (query._id !== undefined) return docs.get(String(query._id)) || null;
      for (const doc of docs.values()) {
        if (Object.entries(query).every(([key, value]) => doc[key] === value)) return doc;
      }
      return null;
    },
    async insertOne(doc) {
      const key = String(doc._id);
      if (docs.has(key)) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
      docs.set(key, { ...doc });
      return { insertedId: doc._id };
    },
    async updateOne(query, update) {
      const key = String(query._id);
      const doc = docs.get(key);
      if (!doc) return { matchedCount: 0 };
      if (update.$set) Object.assign(doc, update.$set);
      return { matchedCount: 1 };
    },
  };
  collections.set(name, fallback);
  return fallback;
}

function assertReconciliationActor(actor, { allowSystem = false } = {}) {
  const principal = typeof actor === 'string'
    ? { id: actor, role: allowSystem && (actor === 'system' || actor === 'worker') ? 'system' : null }
    : actor || {};

  if (principal.role === 'system' && allowSystem) {
    return { id: principal.id || 'system', role: 'system' };
  }
  if (principal.role === 'admin' || principal.role === 'service') {
    return { id: principal.id || principal.actorId || principal.role, role: principal.role };
  }
  throw new EntitlementReconciliationError('UNAUTHORIZED_RECONCILIATION', 'Entitlement reconciliation requires an authorized principal');
}

export function buildRefundEntitlementPlan({ purchase, refund, generatedAt = new Date() } = {}) {
  if (!purchase || !refund) {
    throw new EntitlementReconciliationError('MISSING_SOURCE_RECORD', 'Purchase and refund records are required');
  }
  const purchaseId = String(purchase._id || purchase.purchaseId || '');
  const refundId = String(refund._id || refund.refundId || '');
  const materialId = String(refund.materialId || purchase.materialId || '');
  const buyerAddress = String(refund.buyerAddress || purchase.buyerAddress || '');
  if (!purchaseId || !refundId || !materialId || !buyerAddress) {
    throw new EntitlementReconciliationError('INCOMPLETE_SOURCE_RECORD', 'Purchase and refund identity fields are required');
  }
  if (String(purchase._id || purchase.purchaseId) !== String(refund.purchaseId || refund._id)) {
    if (refund.purchaseId && String(refund.purchaseId) !== purchaseId) {
      throw new EntitlementReconciliationError('SOURCE_MISMATCH', 'Refund does not belong to the purchase');
    }
  }

  const paid = toMinorUnits(purchase.amount);
  const previousRefunds = toMinorUnits(purchase.refundedAmount || 0);
  const refundAmount = toMinorUnits(refund.amount);
  if (paid <= 0n || refundAmount <= 0n) {
    throw new EntitlementReconciliationError('INVALID_AMOUNT', 'Purchase and refund amounts must be positive');
  }

  const totalRefunded = previousRefunds + refundAmount;
  const fullyRefunded = totalRefunded >= paid;
  const action = fullyRefunded ? 'revoke' : 'retain';
  const plan = {
    version: ENTITLEMENT_RECONCILIATION_VERSION,
    purchaseId,
    refundId,
    materialId,
    buyerAddress,
    refundTransactionHash: refund.txHash || null,
    paidAmount: amountString(paid),
    previousRefundedAmount: amountString(previousRefunds),
    refundAmount: amountString(refundAmount),
    totalRefundedAmount: amountString(totalRefunded),
    action,
    desiredState: fullyRefunded ? 'revoked' : 'retained',
    settlementState: fullyRefunded ? 'Refunded' : 'PartiallyRefunded',
    generatedAt: new Date(generatedAt).toISOString(),
  };
  plan.planId = digest({ ...plan, version: ENTITLEMENT_RECONCILIATION_VERSION });
  plan.idempotencyKey = `entitlement-reconciliation:${ENTITLEMENT_RECONCILIATION_VERSION}:${refundId}`;
  return plan;
}

export async function applyRefundEntitlementPlan({
  db,
  plan,
  actor,
  allowSystem = false,
  revokeFn,
  now = new Date(),
} = {}) {
  const principal = assertReconciliationActor(actor, { allowSystem });
  if (!db || !plan || typeof revokeFn !== 'function') {
    throw new EntitlementReconciliationError('INVALID_INPUT', 'db, plan, and revokeFn are required');
  }

  const reconciliations = getCollection(db, ENTITLEMENT_RECONCILIATIONS_COLLECTION);
  let existing = await reconciliations.findOne({ _id: plan.planId });
  if (existing?.status === 'applied') {
    return { outcome: 'replayed', plan: existing.plan || plan, applied: false };
  }

  if (!existing) {
    try {
      await reconciliations.insertOne({
        _id: plan.planId,
        planId: plan.planId,
        plan,
        status: 'pending',
        actor: principal.id,
        createdAt: now,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      existing = await reconciliations.findOne({ _id: plan.planId });
      if (existing?.status === 'applied') {
        return { outcome: 'replayed', plan: existing.plan || plan, applied: false };
      }
    }
  }

  if (plan.action === 'revoke') {
    await revokeFn(plan.materialId, plan.buyerAddress);
  }

  const purchaseQuery = {
    _id: new ObjectId(plan.purchaseId),
    appliedRefundIds: { $ne: plan.refundId },
  };
  await getCollection(db, 'purchases').updateOne(
    purchaseQuery,
    {
      $set: {
        settlementState: plan.settlementState,
        refundedAt: now,
        refundTransactionHash: plan.refundTransactionHash || null,
        updatedAt: now,
      },
      $inc: { refundedAmount: Number(plan.refundAmount) },
      $push: { appliedRefundIds: plan.refundId },
    }
  );

  await getCollection(db, 'refunds').updateOne(
    { _id: new ObjectId(plan.refundId) },
    {
      $set: {
        entitlementReconciliation: {
          planId: plan.planId,
          version: plan.version,
          action: plan.action,
          desiredState: plan.desiredState,
          settlementState: plan.settlementState,
          appliedAt: now,
        },
        entitlementRevoked: plan.action === 'revoke',
        convergedAt: now,
        updatedAt: now,
      },
    }
  );

  await reconciliations.updateOne(
    { _id: plan.planId },
    { $set: { status: 'applied', appliedAt: now, updatedAt: now } }
  );

  return { outcome: 'applied', plan, applied: true };
}

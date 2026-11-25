import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';

export const SETTLEMENT_RECONCILIATION_VERSION = '2026.11.1';
export const PAYOUT_SETTLEMENT_RECONCILIATIONS_COLLECTION = 'payout_settlement_reconciliations';

const PAYOUTS_COLLECTION = 'payouts';
const MINOR_UNIT_SCALE = 1_000_000n;

const SETTLEMENT_JOURNAL = Object.freeze({
  debitAccount: 'collaborator_payable',
  creditAccount: 'sales_receivable',
  sourceEvent: 'payout_settlement',
});

export const SETTLEMENT_AUDIT_EVENT_TYPES = Object.freeze({
  RECONCILED: 'payout_settlement_reconciled',
  DISCREPANCY: 'payout_settlement_discrepancy',
  CONFLICT: 'payout_settlement_conflict',
});

export const SETTLEMENT_RECONCILIATION_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_EVENT: 'INVALID_EVENT',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  UNSAFE_AMOUNT: 'UNSAFE_AMOUNT',
  AMOUNT_PRECISION_UNSUPPORTED: 'AMOUNT_PRECISION_UNSUPPORTED',
  UNAUTHORIZED_RECONCILIATION: 'UNAUTHORIZED_RECONCILIATION',
});

export class SettlementReconciliationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SettlementReconciliationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new SettlementReconciliationError(code, message, details);
}

function canonicalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
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

function requiredString(value, field) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) fail('INVALID_EVENT', `${field} is required`);
  return text;
}

function optionalString(value, transform = (text) => text) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return transform(text);
}

function toIsoDate(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail('INVALID_EVENT', `${field} must be a valid date`);
  return date.toISOString();
}

export function toMinorUnits(value, { integerMeansMinor = true, field = 'amount' } = {}) {
  if (value === undefined || value === null || value === '') {
    fail('INVALID_AMOUNT', `${field} is required`);
  }

  if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    const explicit = value.amountMinorUnits ?? value.minorUnits ?? value.minor;
    if (explicit !== undefined && explicit !== null) {
      return toMinorUnits(explicit, { integerMeansMinor: true, field });
    }
    return toMinorUnits(value.amount, { integerMeansMinor, field });
  }

  if (typeof value === 'bigint') return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_AMOUNT', `${field} must be finite`);
    if (!Number.isSafeInteger(value)) fail('UNSAFE_AMOUNT', `${field} exceeds safe integer precision`);
    const units = BigInt(value);
    return integerMeansMinor ? units : units * MINOR_UNIT_SCALE;
  }

  const text = String(value).trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    fail('INVALID_AMOUNT', `${field} must be an integer in minor units or a decimal amount`);
  }

  const negative = text.startsWith('-');
  const unsigned = negative || text.startsWith('+') ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > 6) {
    fail('AMOUNT_PRECISION_UNSUPPORTED', `${field} supports at most 6 decimal places`);
  }

  const scaled = integerMeansMinor && !fraction
    ? BigInt(whole)
    : BigInt(whole) * MINOR_UNIT_SCALE + BigInt(fraction.padEnd(6, '0') || '0');
  return negative ? -scaled : scaled;
}

function formatMinorUnits(minorUnits) {
  const negative = minorUnits < 0n;
  const absolute = negative ? -minorUnits : minorUnits;
  const whole = absolute / MINOR_UNIT_SCALE;
  const fraction = (absolute % MINOR_UNIT_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole || '0'}${fraction ? `.${fraction}` : ''}`;
}

export function assertSettlementActor(actor, { allowSystem = true } = {}) {
  const systemIds = new Set(['system', 'worker', 'settlement-worker']);
  const principal = typeof actor === 'string'
    ? {
        id: actor,
        role: systemIds.has(actor) ? 'system' : actor.startsWith('service:') ? 'service' : null,
      }
    : actor || {};
  const role = String(principal.role || '').toLowerCase();

  if (role === 'system' && allowSystem) {
    return { id: String(principal.id || 'system'), role: 'system' };
  }
  if (role === 'service' || role === 'admin') {
    return { id: String(principal.id || principal.actorId || principal.sub || role), role };
  }

  fail('UNAUTHORIZED_RECONCILIATION', 'Payout settlement reconciliation requires a system, service, or admin actor');
}

export function normalizeSettlementEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    fail('INVALID_EVENT', 'A settlement event object is required');
  }

  const eventId = requiredString(event.eventId ?? event.id, 'eventId');
  const payoutId = requiredString(event.payoutId, 'payoutId');
  const creatorAddress = requiredString(event.creatorAddress, 'creatorAddress').toLowerCase();
  const asset = requiredString(event.asset, 'asset').toUpperCase();
  const network = requiredString(event.network, 'network').toLowerCase();
  const txHash = requiredString(event.txHash ?? event.transactionHash, 'txHash').toLowerCase();

  const rawType = requiredString(event.eventType ?? event.type, 'eventType').toLowerCase();
  const eventType = rawType === 'payout_settled' ? 'payout.settled' : rawType;

  const occurredAt = toIsoDate(event.occurredAt ?? event.settledAt ?? event.timestamp, 'occurredAt');
  const amountMinorUnits = toMinorUnits(event.amountMinorUnits ?? event.amount, {
    integerMeansMinor: true,
    field: 'event.amount',
  });
  if (amountMinorUnits <= 0n) {
    fail('INVALID_AMOUNT', 'Settlement amount must be positive');
  }

  const normalized = {
    eventId,
    payoutId,
    creatorAddress,
    asset,
    amountMinorUnits: amountMinorUnits.toString(),
    network,
    txHash,
    eventType,
    occurredAt,
  };
  normalized.eventFingerprint = digest(normalized);
  return normalized;
}

function readPayoutAmountMinorUnits(payout) {
  const explicit = payout.amountMinorUnits
    ?? payout.netAmountMinorUnits
    ?? payout.settlementAmountMinorUnits
    ?? payout.amountInMinorUnits;
  if (explicit !== undefined && explicit !== null) {
    return toMinorUnits(explicit, { integerMeansMinor: true, field: 'payout.amountMinorUnits' });
  }

  const major = payout.netAmount ?? payout.settledAmount ?? payout.amount ?? payout.amountMajor;
  if (major !== undefined && major !== null) {
    return toMinorUnits(major, { integerMeansMinor: false, field: 'payout.amount' });
  }
  return null;
}

function detectDiscrepancies(plan, payout) {
  if (!payout) {
    return [{
      code: 'PAYOUT_NOT_FOUND',
      field: 'payoutId',
      expected: plan.payoutId,
      actual: null,
    }];
  }

  const discrepancies = [];
  let expectedAmount = null;
  try {
    expectedAmount = readPayoutAmountMinorUnits(payout);
  } catch (error) {
    discrepancies.push({
      code: 'PAYOUT_AMOUNT_INVALID',
      field: 'amount',
      expected: null,
      actual: plan.amountMinorUnits,
      reason: error.message,
    });
  }

  if (expectedAmount !== null && expectedAmount.toString() !== plan.amountMinorUnits) {
    discrepancies.push({
      code: 'AMOUNT_MISMATCH',
      field: 'amount',
      expected: formatMinorUnits(expectedAmount),
      actual: formatMinorUnits(BigInt(plan.amountMinorUnits)),
      expectedMinorUnits: expectedAmount.toString(),
      actualMinorUnits: plan.amountMinorUnits,
    });
  }

  const payoutCreator = optionalString(
    payout.creatorAddress ?? payout.creatorId ?? payout.walletAddress,
    (text) => text.toLowerCase()
  );
  if (payoutCreator && payoutCreator !== plan.creatorAddress) {
    discrepancies.push({
      code: 'CREATOR_MISMATCH',
      field: 'creatorAddress',
      expected: payoutCreator,
      actual: plan.creatorAddress,
    });
  }

  const payoutAsset = optionalString(payout.asset ?? payout.currency ?? payout.token, (text) => text.toUpperCase());
  if (payoutAsset && payoutAsset !== plan.asset) {
    discrepancies.push({
      code: 'ASSET_MISMATCH',
      field: 'asset',
      expected: payoutAsset,
      actual: plan.asset,
    });
  }

  const payoutNetwork = optionalString(payout.network ?? payout.chain, (text) => text.toLowerCase());
  if (payoutNetwork && payoutNetwork !== plan.network) {
    discrepancies.push({
      code: 'NETWORK_MISMATCH',
      field: 'network',
      expected: payoutNetwork,
      actual: plan.network,
    });
  }

  const payoutTxHash = optionalString(payout.txHash ?? payout.transactionHash ?? payout.settlementTxHash, (text) => text.toLowerCase());
  if (payoutTxHash && payoutTxHash !== plan.txHash) {
    discrepancies.push({
      code: 'TX_HASH_MISMATCH',
      field: 'txHash',
      expected: payoutTxHash,
      actual: plan.txHash,
    });
  }

  return discrepancies;
}

function snapshotPayout(payout) {
  if (!payout) return null;
  let amountMinorUnits = null;
  try {
    amountMinorUnits = readPayoutAmountMinorUnits(payout)?.toString() ?? null;
  } catch {
    amountMinorUnits = null;
  }
  return {
    id: String(payout._id ?? payout.payoutId ?? payout.id ?? ''),
    creatorAddress: optionalString(payout.creatorAddress ?? payout.creatorId ?? payout.walletAddress, (text) => text.toLowerCase()),
    asset: optionalString(payout.asset ?? payout.currency ?? payout.token, (text) => text.toUpperCase()),
    amount: payout.amount === undefined ? null : String(payout.amount),
    amountMinorUnits,
    network: optionalString(payout.network ?? payout.chain, (text) => text.toLowerCase()),
    txHash: optionalString(payout.txHash ?? payout.transactionHash ?? payout.settlementTxHash, (text) => text.toLowerCase()),
    status: payout.status === undefined ? null : String(payout.status),
  };
}

function planEventEvidence(plan) {
  return {
    eventId: plan.eventId,
    payoutId: plan.payoutId,
    creatorAddress: plan.creatorAddress,
    asset: plan.asset,
    amountMinorUnits: plan.amountMinorUnits,
    network: plan.network,
    txHash: plan.txHash,
    eventType: plan.eventType,
    occurredAt: plan.occurredAt,
    eventFingerprint: plan.eventFingerprint,
  };
}

export function buildSettlementReconciliation({ event, payout, generatedAt = new Date() } = {}) {
  const normalized = normalizeSettlementEvent(event);
  const builtAt = toIsoDate(generatedAt, 'generatedAt');
  const planId = digest({ version: SETTLEMENT_RECONCILIATION_VERSION, eventId: normalized.eventId });
  const idempotencyKey = `settlement-reconciliation:${SETTLEMENT_RECONCILIATION_VERSION}:${normalized.eventId}`;
  const discrepancies = payout === undefined ? [] : detectDiscrepancies(normalized, payout);

  const plan = {
    version: SETTLEMENT_RECONCILIATION_VERSION,
    planId,
    idempotencyKey,
    eventId: normalized.eventId,
    payoutId: normalized.payoutId,
    creatorAddress: normalized.creatorAddress,
    asset: normalized.asset,
    amountMinorUnits: normalized.amountMinorUnits,
    network: normalized.network,
    txHash: normalized.txHash,
    eventType: normalized.eventType,
    occurredAt: normalized.occurredAt,
    eventFingerprint: normalized.eventFingerprint,
    journal: {
      txnId: idempotencyKey,
      debitAccount: SETTLEMENT_JOURNAL.debitAccount,
      creditAccount: SETTLEMENT_JOURNAL.creditAccount,
      sourceEvent: SETTLEMENT_JOURNAL.sourceEvent,
      amountMinorUnits: normalized.amountMinorUnits,
    },
    discrepancies,
    status: discrepancies.length > 0 ? 'discrepancy' : 'pending',
    generatedAt: builtAt,
  };
  plan.planHash = digest(plan);
  return plan;
}

async function findExistingReconciliation(reconciliations, plan) {
  return reconciliations.findOne({
    $or: [{ _id: plan.planId }, { eventId: plan.eventId }],
  });
}

async function findPayout(db, payoutId) {
  const collection = db.collection(PAYOUTS_COLLECTION);
  const queries = [{ _id: payoutId }];
  if (ObjectId.isValid(payoutId)) queries.push({ _id: new ObjectId(payoutId) });
  queries.push({ payoutId }, { id: payoutId });

  for (const query of queries) {
    const payout = await collection.findOne(query);
    if (payout) return payout;
  }
  return null;
}

function recordIsComplete(record) {
  if (record.status === 'applied') return Boolean(record.journalPostedAt && record.auditedAt);
  if (record.status === 'discrepancy' || record.status === 'conflict') return Boolean(record.auditedAt);
  return false;
}

function replayResult(record, plan) {
  const outcome = record.status === 'applied'
    ? 'replayed'
    : record.status === 'conflict'
      ? 'conflict_replayed'
      : 'discrepancy_replayed';
  return {
    outcome,
    applied: false,
    plan: record.plan || plan,
    discrepancies: record.discrepancies || [],
    reconciliation: record,
  };
}

function buildAudit({ plan, principal, timestamp, operationId, eventType, status, discrepancies, payoutSnapshot, journalEntry }) {
  return {
    operationId,
    eventType,
    actor: principal.id,
    actorContext: { role: principal.role, source: 'payout-settlement-reconciliation' },
    financialDetails: {
      version: SETTLEMENT_RECONCILIATION_VERSION,
      eventId: plan.eventId,
      payoutId: plan.payoutId,
      amount: plan.amountMinorUnits,
      amountUnit: 'minor',
      asset: plan.asset,
      network: plan.network,
      txHash: plan.txHash,
      occurredAt: plan.occurredAt,
      planId: plan.planId,
    },
    target: { type: 'payout', id: plan.payoutId },
    intent: { source: 'settlement-event', eventId: plan.eventId },
    beforeState: payoutSnapshot,
    afterState: journalEntry
      ? { journal: { txnId: journalEntry.txnId ?? plan.journal.txnId, debitAccount: plan.journal.debitAccount, creditAccount: plan.journal.creditAccount, amountMinorUnits: plan.amountMinorUnits } }
      : { reconciliationStatus: status },
    result: { status, discrepancies },
    reason: status === 'discrepancy' || status === 'conflict' ? 'Settlement evidence did not match trusted payout state' : null,
    timestamp,
  };
}

async function recordConflict({ db, plan, existing, principal, timestamp, recordAuditFn, reconciliations }) {
  const storedFingerprint = existing.eventFingerprint || existing.plan?.eventFingerprint || digest(existing.event || {});
  const conflictId = digest({
    version: SETTLEMENT_RECONCILIATION_VERSION,
    kind: 'conflict',
    eventId: plan.eventId,
    storedFingerprint,
    incomingFingerprint: plan.eventFingerprint,
  });

  let conflict = await reconciliations.findOne({ _id: conflictId });
  if (conflict && recordIsComplete(conflict)) return replayResult(conflict, plan);

  const discrepancy = {
    code: 'DUPLICATE_CONFLICT',
    field: 'eventId',
    eventId: plan.eventId,
    expectedFingerprint: storedFingerprint,
    actualFingerprint: plan.eventFingerprint,
  };

  if (!conflict) {
    conflict = {
      _id: conflictId,
      kind: 'conflict',
      version: SETTLEMENT_RECONCILIATION_VERSION,
      eventId: plan.eventId,
      payoutId: plan.payoutId,
      eventFingerprint: plan.eventFingerprint,
      status: 'conflict',
      discrepancies: [discrepancy],
      evidence: {
        storedEvent: existing.event || planEventEvidence(existing.plan || {}),
        incomingEvent: planEventEvidence(plan),
      },
      actor: principal.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await reconciliations.insertOne(conflict);
    } catch (error) {
      if (error?.code !== 11000) throw error;
      conflict = await reconciliations.findOne({ _id: conflictId });
      if (conflict && recordIsComplete(conflict)) return replayResult(conflict, plan);
    }
  }

  if (!conflict?.auditedAt) {
    await recordAuditFn(buildAudit({
      plan,
      principal,
      timestamp,
      operationId: `settlement-conflict:${conflictId}`,
      eventType: SETTLEMENT_AUDIT_EVENT_TYPES.CONFLICT,
      status: 'conflict',
      discrepancies: conflict?.discrepancies || [discrepancy],
      payoutSnapshot: existing.payoutSnapshot || null,
      journalEntry: null,
    }));
    await reconciliations.updateOne(
      { _id: conflictId },
      { $set: { auditedAt: timestamp, updatedAt: timestamp } }
    );
  }

  return {
    outcome: 'conflict',
    applied: false,
    plan,
    discrepancies: conflict?.discrepancies || [discrepancy],
    reconciliation: conflict,
  };
}

async function reconcileOne({
  db,
  event,
  actor,
  allowSystem = true,
  appendJournalEntryFn,
  recordAuditFn,
  now = new Date(),
} = {}) {
  const principal = assertSettlementActor(actor, { allowSystem });
  if (!db || typeof db.collection !== 'function') {
    fail('INVALID_INPUT', 'db is required');
  }
  if (typeof recordAuditFn !== 'function') {
    fail('INVALID_INPUT', 'recordAuditFn is required');
  }

  const timestamp = toIsoDate(now, 'now');
  const plan = buildSettlementReconciliation({ event, generatedAt: timestamp });
  const reconciliations = db.collection(PAYOUT_SETTLEMENT_RECONCILIATIONS_COLLECTION);
  if (!reconciliations) {
    fail('INVALID_INPUT', 'reconciliation collection is unavailable');
  }

  let record = await findExistingReconciliation(reconciliations, plan);
  if (record && (record.eventFingerprint || record.plan?.eventFingerprint) !== plan.eventFingerprint) {
    return recordConflict({ db, plan, existing: record, principal, timestamp, recordAuditFn, reconciliations });
  }
  if (record && recordIsComplete(record)) {
    return replayResult(record, plan);
  }

  let payoutSnapshot = record?.payoutSnapshot || null;
  let discrepancies = record?.discrepancies || [];
  if (!record) {
    const payout = await findPayout(db, plan.payoutId);
    payoutSnapshot = snapshotPayout(payout);
    discrepancies = detectDiscrepancies(plan, payout);
    const candidate = {
      _id: plan.planId,
      kind: 'reconciliation',
      version: SETTLEMENT_RECONCILIATION_VERSION,
      eventId: plan.eventId,
      payoutId: plan.payoutId,
      eventFingerprint: plan.eventFingerprint,
      event: planEventEvidence(plan),
      payoutSnapshot,
      status: discrepancies.length > 0 ? 'discrepancy' : 'pending',
      discrepancies,
      plan,
      actor: principal.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await reconciliations.insertOne(candidate);
      record = candidate;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      record = await findExistingReconciliation(reconciliations, plan);
      if (!record) throw error;
      if ((record.eventFingerprint || record.plan?.eventFingerprint) !== plan.eventFingerprint) {
        return recordConflict({ db, plan, existing: record, principal, timestamp, recordAuditFn, reconciliations });
      }
      if (recordIsComplete(record)) return replayResult(record, plan);
      payoutSnapshot = record.payoutSnapshot || payoutSnapshot;
      discrepancies = record.discrepancies || discrepancies;
    }
  }

  if (discrepancies.length > 0) {
    if (!record.auditedAt) {
      await recordAuditFn(buildAudit({
        plan,
        principal,
        timestamp,
        operationId: `settlement-discrepancy:${plan.idempotencyKey}`,
        eventType: SETTLEMENT_AUDIT_EVENT_TYPES.DISCREPANCY,
        status: 'discrepancy',
        discrepancies,
        payoutSnapshot,
        journalEntry: null,
      }));
      await reconciliations.updateOne(
        { _id: record._id },
        { $set: { status: 'discrepancy', auditedAt: timestamp, updatedAt: timestamp } }
      );
    }
    return {
      outcome: record.auditedAt ? 'discrepancy_replayed' : 'discrepancy',
      applied: false,
      plan: record.plan || plan,
      discrepancies,
      reconciliation: record,
    };
  }

  if (typeof appendJournalEntryFn !== 'function') {
    fail('INVALID_INPUT', 'appendJournalEntryFn is required for a balanced settlement');
  }

  let journalEntry = record.journalEntry || null;
  if (!journalEntry) {
    journalEntry = await appendJournalEntryFn({
      creatorId: plan.creatorAddress,
      asset: plan.asset,
      debitAccount: plan.journal.debitAccount,
      creditAccount: plan.journal.creditAccount,
      amount: BigInt(plan.amountMinorUnits),
      txnId: plan.journal.txnId,
      sourceEvent: plan.journal.sourceEvent,
      chainHeight: event.chainHeight ?? event.ledger ?? null,
      metadata: {
        type: 'payout_settlement',
        version: SETTLEMENT_RECONCILIATION_VERSION,
        planId: plan.planId,
        eventId: plan.eventId,
        payoutId: plan.payoutId,
        network: plan.network,
        txHash: plan.txHash,
        occurredAt: plan.occurredAt,
      },
    });
    journalEntry = journalEntry
      ? { txnId: journalEntry.txnId ?? plan.journal.txnId, id: journalEntry._id ? String(journalEntry._id) : null }
      : null;
  }

  if (!record.auditedAt) {
    await recordAuditFn(buildAudit({
      plan,
      principal,
      timestamp,
      operationId: `settlement:${plan.idempotencyKey}`,
      eventType: SETTLEMENT_AUDIT_EVENT_TYPES.RECONCILED,
      status: 'posted',
      discrepancies: [],
      payoutSnapshot,
      journalEntry,
    }));
  }

  await reconciliations.updateOne(
    { _id: record._id },
    {
      $set: {
        status: 'applied',
        journalEntry,
        journalPostedAt: record.journalPostedAt || timestamp,
        auditedAt: record.auditedAt || timestamp,
        appliedAt: record.appliedAt || timestamp,
        updatedAt: timestamp,
      },
    }
  );

  return {
    outcome: 'applied',
    applied: true,
    plan: record.plan || plan,
    discrepancies: [],
    journalEntry,
    reconciliation: { ...record, status: 'applied', journalEntry, appliedAt: record.appliedAt || timestamp },
  };
}

export async function reconcilePayoutSettlement(options = {}) {
  const { events, event } = options;
  if (events !== undefined) {
    if (!Array.isArray(events)) fail('INVALID_EVENT', 'events must be an array');
    const results = [];
    for (const item of events) {
      results.push(await reconcileOne({ ...options, event: item }));
    }
    return { results, count: results.length };
  }
  return reconcileOne({ ...options, event });
}

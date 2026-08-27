import crypto from 'node:crypto';
import { COLLECTIONS } from './schemaContracts';

export const AUDIT_LEDGER_VERSION = 'v1';
const GENESIS_HASH = '0'.repeat(64);

function normalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
}

export function canonicalize(value) {
  return JSON.stringify(normalize(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

function actorProof(actor, actorContext = {}) {
  return digest({ actor: String(actor || 'system'), ...actorContext });
}

export async function appendAuditRecord({
  db,
  operationId,
  actor,
  actorContext,
  action,
  target,
  result,
  reason = null,
  intent = {},
}) {
  if (!operationId || !action || !target) throw new Error('operationId, action, and target are required');
  const collection = db.collection(COLLECTIONS.auditLedger);
  const existing = await collection.findOne({ operationId: String(operationId) });
  if (existing) return existing;

  // The operation id makes retries idempotent. A unique sequence index makes
  // competing writers retry from the newest chain head instead of forking it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [last] = await collection.find({}).sort({ sequence: -1 }).limit(1).toArray();
    const sequence = (last?.sequence ?? -1) + 1;
    const previousHash = last?.recordHash || GENESIS_HASH;
    const createdAt = new Date();
    const record = {
      version: AUDIT_LEDGER_VERSION,
      operationId: String(operationId),
      sequence,
      previousHash,
      actor: String(actor || 'system'),
      actorProof: actorProof(actor, actorContext),
      action: String(action),
      target: normalize(target),
      intentHash: digest(intent),
      result: normalize(result || {}),
      reason: reason ? String(reason).slice(0, 500) : null,
      createdAt,
    };
    const recordHash = digest(record);
    try {
      await collection.insertOne({ ...record, recordHash });
      return { ...record, recordHash };
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const duplicate = await collection.findOne({ operationId: String(operationId) });
      if (duplicate) return duplicate;
    }
  }
  throw new Error('Could not append audit record without a chain conflict');
}

export async function readAuditRecords(db, filter = {}) {
  const query = {};
  for (const key of ['action', 'actor', 'operationId']) {
    if (filter[key]) query[key] = String(filter[key]);
  }
  if (filter.targetType) query['target.type'] = String(filter.targetType);
  if (filter.from || filter.to) {
    query.createdAt = {};
    if (filter.from) query.createdAt.$gte = new Date(filter.from);
    if (filter.to) query.createdAt.$lte = new Date(filter.to);
  }
  return db.collection(COLLECTIONS.auditLedger).find(query).sort({ sequence: 1 }).limit(filter.limit || 1000).toArray();
}

export function verifyAuditRecords(records) {
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const { recordHash, _id, ...content } = record;
    if (content.sequence !== index || content.previousHash !== previousHash) {
      return { valid: false, brokenAtSequence: content.sequence ?? index };
    }
    if (digest(content) !== recordHash) {
      return { valid: false, brokenAtSequence: content.sequence };
    }
    previousHash = recordHash;
  }
  return { valid: true, brokenAtSequence: null, records: records.length };
}

export async function createAuditCheckpoint(db) {
  const records = await db.collection(COLLECTIONS.auditLedger).find({}).sort({ sequence: 1 }).toArray();
  const verification = verifyAuditRecords(records);
  if (!verification.valid) throw new Error(`Cannot checkpoint broken audit chain at ${verification.brokenAtSequence}`);
  const checkpoint = {
    sequence: records.at(-1)?.sequence ?? -1,
    recordHash: records.at(-1)?.recordHash || GENESIS_HASH,
    createdAt: new Date(),
  };
  await db.collection(COLLECTIONS.auditCheckpoints).updateOne(
    { sequence: checkpoint.sequence },
    { $setOnInsert: checkpoint },
    { upsert: true },
  );
  const anchorUrl = process.env.AUDIT_CHECKPOINT_URL;
  if (anchorUrl) {
    const response = await fetch(anchorUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(checkpoint),
    });
    if (!response.ok) throw new Error(`External audit checkpoint failed: ${response.status}`);
  }
  return checkpoint;
}
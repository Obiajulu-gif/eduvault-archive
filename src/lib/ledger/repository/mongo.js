/**
 * MongoDB ledger repository (runtime).
 *
 * Mirrors {@link InMemoryLedgerRepository}. Posted transactions live in an
 * append-only collection with a unique index on `idempotencyKey`; there is no
 * update or delete path for posted history. Duplicate-key errors on insert are
 * treated as successful idempotent no-ops.
 *
 * Constructing the repository performs no I/O and does not open a connection,
 * so importing this module in a non-Mongo environment (for example, unit tests
 * or the client bundle) is safe.
 */

import { createTransaction } from "../journal.js";

const DUPLICATE_KEY = 11000;

export const LEDGER_COLLECTIONS = Object.freeze({
  TRANSACTIONS: "ledger_transactions",
  CHECKPOINTS: "ledger_checkpoints",
  SNAPSHOTS: "ledger_period_snapshots",
});

export class MongoLedgerRepository {
  constructor(db) {
    if (!db) throw new Error("MongoLedgerRepository requires a Mongo Db instance");
    this.db = db;
    this.transactions = db.collection(LEDGER_COLLECTIONS.TRANSACTIONS);
    this.checkpoints = db.collection(LEDGER_COLLECTIONS.CHECKPOINTS);
    this.snapshots = db.collection(LEDGER_COLLECTIONS.SNAPSHOTS);
  }

  /** Create the unique idempotency index. Call once during setup/migration. */
  async ensureIndexes() {
    await this.transactions.createIndex({ idempotencyKey: 1 }, { unique: true });
    await this.transactions.createIndex({ "source.txHash": 1, "source.opIndex": 1 });
    await this.transactions.createIndex({ occurredAt: 1 });
    await this.checkpoints.createIndex({ name: 1 }, { unique: true });
    await this.snapshots.createIndex({ asOf: 1 }, { unique: true });
  }

  async append(input) {
    const transaction = input.lines && input.eventType && !input.id ? createTransaction(input) : input;
    const doc = { ...transaction, postedAt: new Date().toISOString() };
    try {
      await this.transactions.insertOne(doc);
      return { transaction: Object.freeze(doc), deduplicated: false };
    } catch (error) {
      if (error?.code === DUPLICATE_KEY) {
        const existing = await this.transactions.findOne({ idempotencyKey: transaction.idempotencyKey });
        return { transaction: existing, deduplicated: true };
      }
      throw error;
    }
  }

  async getById(id) {
    return this.transactions.findOne({ id });
  }

  async getByIdempotencyKey(key) {
    return this.transactions.findOne({ idempotencyKey: key });
  }

  async list(filter = {}) {
    const query = {};
    if (filter.eventType) query.eventType = filter.eventType;
    if (filter.settlementState) query.settlementState = filter.settlementState;
    if (filter.txHash) query["source.txHash"] = filter.txHash;
    return this.transactions.find(query).sort({ postedAt: 1 }).toArray();
  }

  async all() {
    return this.list();
  }

  async saveCheckpoint(name, value) {
    await this.checkpoints.updateOne({ name }, { $set: { name, value, updatedAt: new Date() } }, { upsert: true });
  }

  async getCheckpoint(name) {
    const doc = await this.checkpoints.findOne({ name });
    return doc ? doc.value : null;
  }

  async savePeriodSnapshot(snapshot) {
    // Snapshots are immutable once written: insert only, never overwrite.
    await this.snapshots.insertOne({ ...snapshot });
    return snapshot;
  }

  async getPeriodSnapshot(asOf) {
    return this.snapshots.findOne({ asOf });
  }
}

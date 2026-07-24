/**
 * In-memory ledger repository.
 *
 * Append-only: there is no update or delete of posted transactions. `append`
 * is idempotent by idempotency key, so replaying the same source event returns
 * the existing transaction and never duplicates it. Used by tests and local
 * development; production uses the Mongo repository with the same contract.
 */

import { createTransaction } from "../journal.js";

export class InMemoryLedgerRepository {
  constructor() {
    this.byId = new Map();
    this.byKey = new Map();
    this.order = [];
    this.checkpoints = new Map();
    this.snapshots = new Map();
  }

  /**
   * Append a transaction. Returns `{ transaction, deduplicated }`. When a
   * transaction with the same idempotency key already exists, the stored one is
   * returned with `deduplicated: true` and nothing new is written.
   */
  async append(input) {
    const transaction = input.lines && input.eventType && !input.id ? createTransaction(input) : input;
    const existing = this.byKey.get(transaction.idempotencyKey);
    if (existing) {
      return { transaction: existing, deduplicated: true };
    }
    const stored = Object.freeze({ ...transaction, postedAt: new Date().toISOString() });
    this.byId.set(stored.id, stored);
    this.byKey.set(stored.idempotencyKey, stored);
    this.order.push(stored.id);
    return { transaction: stored, deduplicated: false };
  }

  async getById(id) {
    return this.byId.get(id) ?? null;
  }

  async getByIdempotencyKey(key) {
    return this.byKey.get(key) ?? null;
  }

  /** List transactions in insertion order, optionally filtered. */
  async list(filter = {}) {
    let items = this.order.map((id) => this.byId.get(id));
    if (filter.eventType) items = items.filter((tx) => tx.eventType === filter.eventType);
    if (filter.settlementState) items = items.filter((tx) => tx.settlementState === filter.settlementState);
    if (filter.txHash) items = items.filter((tx) => tx.source?.txHash === filter.txHash);
    return items;
  }

  async all() {
    return this.list();
  }

  async saveCheckpoint(name, value) {
    this.checkpoints.set(name, value);
  }

  async getCheckpoint(name) {
    return this.checkpoints.has(name) ? this.checkpoints.get(name) : null;
  }

  async savePeriodSnapshot(snapshot) {
    this.snapshots.set(snapshot.asOf, snapshot);
    return snapshot;
  }

  async getPeriodSnapshot(asOf) {
    return this.snapshots.get(asOf) ?? null;
  }
}

/**
 * Tests for the asynchronous Stellar payment reconciliation job — Issue #418.
 *
 * Exercises the real reconcilePendingPurchases logic against an in-memory
 * MongoDB collection mock and an injected transaction-status resolver, so no
 * network or database is required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reconcilePendingPurchases,
  PENDING_RECONCILE_STATUSES,
} from "../../src/lib/purchases/paymentReconciler.js";

// ── Minimal purchases collection mock ────────────────────────────────────────

function createPurchasesCollection(records = []) {
  let docs = records.map((r, i) => ({ _id: r._id ?? `p${i + 1}`, ...r }));
  return {
    get docs() {
      return docs;
    },
    find(query) {
      const statusIn = query?.status?.$in ?? null;
      const hashNin = query?.transactionHash?.$nin ?? null;
      let filtered = docs.filter((d) => {
        if (statusIn && !statusIn.includes(d.status)) return false;
        if (hashNin && hashNin.includes(d.transactionHash)) return false;
        return true;
      });
      return {
        limit(n) {
          filtered = filtered.slice(0, n);
          return this;
        },
        async toArray() {
          return filtered;
        },
      };
    },
    async updateOne(query, update) {
      const doc = docs.find((d) => d._id === query._id);
      if (doc) Object.assign(doc, update.$set ?? {});
    },
  };
}

function createDb(purchases) {
  return { collection: (name) => (name === "purchases" ? purchases : null) };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("confirms a pending purchase whose transaction succeeded on-chain", async () => {
  const purchases = createPurchasesCollection([
    { _id: "p1", materialId: "mat-1", buyerAddress: "gabc", status: "pending", transactionHash: "hash-ok", amount: "5", asset: "USDC" },
  ]);
  const granted = [];
  const confirmed = [];

  const summary = await reconcilePendingPurchases({
    db: createDb(purchases),
    getTransactionStatus: async () => "confirmed",
    grantEntitlement: async (materialId, buyerAddress, meta) => granted.push({ materialId, buyerAddress, meta }),
    onConfirmed: async (p) => confirmed.push(p),
  });

  assert.deepEqual(summary, { checked: 1, confirmed: 1, failed: 0, stillPending: 0, errors: 0 });
  assert.equal(purchases.docs[0].status, "confirmed");
  assert.ok(purchases.docs[0].confirmedAt instanceof Date);
  assert.equal(granted.length, 1);
  assert.equal(granted[0].materialId, "mat-1");
  assert.equal(granted[0].meta.transactionHash, "hash-ok");
  assert.equal(confirmed.length, 1);
});

test("marks a purchase failed when the transaction did not succeed", async () => {
  const purchases = createPurchasesCollection([
    { _id: "p1", materialId: "mat-1", buyerAddress: "gabc", status: "pending", transactionHash: "hash-bad" },
  ]);
  const granted = [];

  const summary = await reconcilePendingPurchases({
    db: createDb(purchases),
    getTransactionStatus: async () => "failed",
    grantEntitlement: async (...a) => granted.push(a),
  });

  assert.equal(summary.failed, 1);
  assert.equal(summary.confirmed, 0);
  assert.equal(purchases.docs[0].status, "failed");
  assert.equal(granted.length, 0, "no entitlement granted for failed payment");
});

test("leaves a purchase pending when the transaction is not yet on-chain", async () => {
  const purchases = createPurchasesCollection([
    { _id: "p1", materialId: "mat-1", buyerAddress: "gabc", status: "pending", transactionHash: "hash-pending" },
  ]);

  const summary = await reconcilePendingPurchases({
    db: createDb(purchases),
    getTransactionStatus: async () => "pending",
    grantEntitlement: async () => {},
  });

  assert.equal(summary.stillPending, 1);
  assert.equal(purchases.docs[0].status, "pending");
});

test("skips purchases without a transaction hash and already-confirmed ones", async () => {
  const purchases = createPurchasesCollection([
    { _id: "p1", materialId: "mat-1", buyerAddress: "g1", status: "pending", transactionHash: null },
    { _id: "p2", materialId: "mat-2", buyerAddress: "g2", status: "pending", transactionHash: "" },
    { _id: "p3", materialId: "mat-3", buyerAddress: "g3", status: "confirmed", transactionHash: "done" },
  ]);

  const summary = await reconcilePendingPurchases({
    db: createDb(purchases),
    getTransactionStatus: async () => "confirmed",
    grantEntitlement: async () => {},
  });

  assert.equal(summary.checked, 0, "nothing eligible to reconcile");
});

test("counts an error and continues when the status lookup throws", async () => {
  const purchases = createPurchasesCollection([
    { _id: "p1", materialId: "mat-1", buyerAddress: "g1", status: "pending", transactionHash: "boom" },
    { _id: "p2", materialId: "mat-2", buyerAddress: "g2", status: "pending", transactionHash: "hash-ok" },
  ]);
  const granted = [];

  const summary = await reconcilePendingPurchases({
    db: createDb(purchases),
    getTransactionStatus: async (hash) => {
      if (hash === "boom") throw new Error("horizon down");
      return "confirmed";
    },
    grantEntitlement: async (...a) => granted.push(a),
  });

  assert.equal(summary.errors, 1);
  assert.equal(summary.confirmed, 1);
  assert.equal(granted.length, 1, "second purchase still processed after first errored");
});

test("exports the set of statuses treated as pending", () => {
  assert.ok(PENDING_RECONCILE_STATUSES.includes("pending"));
  assert.ok(PENDING_RECONCILE_STATUSES.includes("processing"));
});

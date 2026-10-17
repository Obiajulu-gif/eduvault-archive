/**
 * Formal lifecycle state-machine tests.
 *
 * For each machine (material lifecycle, refund, dispute, publication saga) the
 * expected edge set is declared here as a literal, independent of the
 * implementation's table. Every (from, to) pair is then checked, so adding,
 * removing or mis-wiring an edge fails a test. Terminal states and recovery
 * paths get dedicated end-to-end cases.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { createFakeCollection, createFakeDb } from "@/lib/refunds/__tests__/fakeMongo";
import { COLLECTIONS } from "@/lib/backend/schemaContracts";

const auditLogMock = vi.fn();
vi.mock("@/lib/api/audit", () => ({ auditLog: (...args) => auditLogMock(...args) }));

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/checkout/refundVerifier", () => ({
  verifyRefundLimit: vi.fn(async () => ({ valid: true })),
}));

vi.mock("@/lib/notifications/notifications", () => ({
  notifyWalletRecipient: vi.fn(async () => ({})),
}));

let sagaDb;
vi.mock("@/lib/mongodb", () => ({ getDb: vi.fn(async () => sagaDb) }));

const material = await import("@/lib/db/materialLifecycle");
const refunds = await import("@/lib/refunds/refundWorkflow");
const disputes = await import("@/lib/refunds/disputeWorkflow");
const saga = await import("@/lib/backend/publicationSaga");

const { MaterialLifecycleState: M, LIFECYCLE_ERROR_CODES } = material;
const { REFUND_STATUS: R } = refunds;
const { DISPUTE_STATUS: D } = disputes;
const { PUBLICATION_STATES: S } = saga;

const pairs = (states) => states.flatMap((from) => states.map((to) => [from, to]));
const edgeSet = (edges) => new Set(edges.map(([from, to]) => `${from}->${to}`));

// ---------------------------------------------------------------------------
// Material lifecycle
// ---------------------------------------------------------------------------

const MATERIAL_STATES = Object.values(M);
const MATERIAL_EDGES = edgeSet([
  [M.DRAFT, M.ACTIVE],
  ...[M.PAUSED, M.ARCHIVED, M.SUSPENDED, M.RETIRED, M.REMOVED].map((to) => [M.ACTIVE, to]),
  ...[M.ACTIVE, M.ARCHIVED, M.SUSPENDED, M.RETIRED, M.REMOVED].map((to) => [M.PAUSED, to]),
  ...[M.ACTIVE, M.RETIRED, M.SUSPENDED, M.REMOVED].map((to) => [M.ARCHIVED, to]),
  [M.SUSPENDED, M.ACTIVE],
  [M.SUSPENDED, M.REMOVED],
  [M.RETIRED, M.ACTIVE],
  [M.RETIRED, M.REMOVED],
]);

function makeMaterialDb(lifecycleState, extra = {}) {
  const materials = createFakeCollection();
  const _id = new ObjectId();
  const doc = { _id, title: "m", ...(lifecycleState === undefined ? {} : { lifecycleState }), ...extra };
  materials.docs.push(doc);
  return { db: createFakeDb({ materials }), materials, _id, doc };
}

describe("material lifecycle state machine", () => {
  beforeEach(() => auditLogMock.mockClear());

  it("only REMOVED is terminal", () => {
    expect(material.TERMINAL_STATES).toEqual([M.REMOVED]);
    expect(material.isTerminalState(M.REMOVED)).toBe(true);
    for (const state of MATERIAL_STATES.filter((s) => s !== M.REMOVED)) {
      expect(material.isTerminalState(state), state).toBe(false);
    }
  });

  it.each(pairs(MATERIAL_STATES))("isValidTransition(%s -> %s) matches the declared edge set", (from, to) => {
    const expected = from === to || MATERIAL_EDGES.has(`${from}->${to}`);
    expect(material.isValidTransition(from, to)).toBe(expected);
  });

  it("treats a missing state as draft and rejects unknown states, even for identity", () => {
    expect(material.isValidTransition(undefined, M.ACTIVE)).toBe(true);
    expect(material.isValidTransition(null, M.ARCHIVED)).toBe(false);
    expect(material.isValidTransition("bogus", "bogus")).toBe(false);
    expect(material.isValidTransition(M.ACTIVE, "bogus")).toBe(false);
    expect(material.isValidTransition(M.ACTIVE, undefined)).toBe(false);
  });

  it.each(pairs(MATERIAL_STATES).filter(([from, to]) => from !== to))(
    "transitionMaterialState(%s -> %s) is deterministic",
    async (from, to) => {
      const { db, materials, _id } = makeMaterialDb(from);
      const legal = MATERIAL_EDGES.has(`${from}->${to}`);

      if (legal) {
        const result = await material.transitionMaterialState(db, _id, to, { actor: "admin" });
        expect(result.lifecycleState).toBe(to);
        expect(materials.docs[0].lifecycleState).toBe(to);
        expect(auditLogMock).toHaveBeenCalledTimes(1);
      } else {
        const error = await material.transitionMaterialState(db, _id, to, { actor: "admin" }).catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe(LIFECYCLE_ERROR_CODES.INVALID_TRANSITION);
        expect(error.message).toBe(`Invalid lifecycle transition from ${from} to ${to}`);
        expect(materials.docs[0].lifecycleState).toBe(from);
        expect(auditLogMock).not.toHaveBeenCalled();
      }
    }
  );

  it("treats legacy documents without lifecycleState as draft", async () => {
    const { db, materials, _id } = makeMaterialDb(undefined);
    await material.transitionMaterialState(db, _id, M.ACTIVE, { actor: "a" });
    expect(materials.docs[0].lifecycleState).toBe(M.ACTIVE);

    const legacy = makeMaterialDb(undefined);
    const error = await material.transitionMaterialState(legacy.db, legacy._id, M.RETIRED).catch((e) => e);
    expect(error.code).toBe(LIFECYCLE_ERROR_CODES.INVALID_TRANSITION);
  });

  it("reports a missing material with a stable error code", async () => {
    const { db } = makeMaterialDb(M.ACTIVE);
    const error = await material.transitionMaterialState(db, new ObjectId(), M.PAUSED).catch((e) => e);
    expect(error.code).toBe(LIFECYCLE_ERROR_CODES.NOT_FOUND);
  });

  it("same-state request is an idempotent no-op that preserves deletion metadata and writes no audit", async () => {
    const deletedAt = new Date("2026-01-01T00:00:00Z");
    const { db, materials, _id } = makeMaterialDb(M.RETIRED, { isDeleted: true, deletedAt, deletedBy: "first" });

    const result = await material.transitionMaterialState(db, _id, M.RETIRED, { actor: "second" });

    expect(result.lifecycleState).toBe(M.RETIRED);
    expect(materials.docs[0].deletedBy).toBe("first");
    expect(materials.docs[0].deletedAt).toBe(deletedAt);
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  describe("terminal state", () => {
    it("REMOVED sets a legal tombstone and can never be left", async () => {
      const { db, materials, _id } = makeMaterialDb(M.ACTIVE);
      await material.transitionMaterialState(db, _id, M.REMOVED, { actor: "legal" });
      expect(materials.docs[0].legalTombstone).toBe(true);

      for (const to of MATERIAL_STATES.filter((s) => s !== M.REMOVED)) {
        const error = await material.transitionMaterialState(db, _id, to).catch((e) => e);
        expect(error.code, to).toBe(LIFECYCLE_ERROR_CODES.INVALID_TRANSITION);
      }
      expect(materials.docs[0].lifecycleState).toBe(M.REMOVED);
    });
  });

  describe("recovery transitions restore the legacy flags they set", () => {
    it("retired -> active clears soft-delete fields", async () => {
      const { db, materials, _id } = makeMaterialDb(M.ACTIVE);
      await material.transitionMaterialState(db, _id, M.RETIRED, { actor: "creator", reason: "oops" });
      expect(materials.docs[0]).toMatchObject({ isDeleted: true, deletedBy: "creator", deletionReason: "oops" });

      await material.transitionMaterialState(db, _id, M.ACTIVE, { actor: "creator" });
      expect(materials.docs[0]).toMatchObject({
        lifecycleState: M.ACTIVE,
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        deletionReason: null,
      });
    });

    it("archived -> active clears the archived flag", async () => {
      const { db, materials, _id } = makeMaterialDb(M.ACTIVE);
      await material.transitionMaterialState(db, _id, M.ARCHIVED, { actor: "c" });
      expect(materials.docs[0].archived).toBe(true);
      await material.transitionMaterialState(db, _id, M.ACTIVE, { actor: "c" });
      expect(materials.docs[0].archived).toBe(false);
    });

    it("suspended -> active (moderation overturned) restores approved moderation status", async () => {
      const { db, materials, _id } = makeMaterialDb(M.ACTIVE);
      await material.transitionMaterialState(db, _id, M.SUSPENDED, { actor: "mod" });
      expect(materials.docs[0].moderationStatus).toBe("suspended");
      await material.transitionMaterialState(db, _id, M.ACTIVE, { actor: "mod" });
      expect(materials.docs[0].moderationStatus).toBe("approved");
    });

    it("suspended cannot skip review into archived or paused", async () => {
      for (const to of [M.ARCHIVED, M.PAUSED, M.RETIRED]) {
        const { db, _id } = makeMaterialDb(M.SUSPENDED);
        const error = await material.transitionMaterialState(db, _id, to).catch((e) => e);
        expect(error.code, to).toBe(LIFECYCLE_ERROR_CODES.INVALID_TRANSITION);
      }
    });
  });

  describe("concurrent writers", () => {
    it("lets exactly one of two racing transitions win; the loser fails without overwriting", async () => {
      const { db, materials, _id } = makeMaterialDb(M.ACTIVE);

      const results = await Promise.allSettled([
        material.transitionMaterialState(db, _id, M.RETIRED, { actor: "creator" }),
        material.transitionMaterialState(db, _id, M.SUSPENDED, { actor: "moderator" }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const loser = results.find((r) => r.status === "rejected").reason;
      expect(loser.code).toBe(LIFECYCLE_ERROR_CODES.CONCURRENT_MODIFICATION);
      expect(materials.docs[0].lifecycleState).toBe(M.RETIRED);
      expect(auditLogMock).toHaveBeenCalledTimes(1);
    });

    it("a stale read cannot resurrect a REMOVED material", async () => {
      const { db, materials, _id } = makeMaterialDb(M.RETIRED);
      const results = await Promise.allSettled([
        material.transitionMaterialState(db, _id, M.REMOVED, { actor: "legal" }),
        material.transitionMaterialState(db, _id, M.ACTIVE, { actor: "creator" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(materials.docs[0].lifecycleState).toBe(M.REMOVED);
    });

    it("draft guard also matches legacy docs with null lifecycleState", async () => {
      const { db, materials, _id } = makeMaterialDb(null);
      await material.transitionMaterialState(db, _id, M.ACTIVE, { actor: "c" });
      expect(materials.docs[0].lifecycleState).toBe(M.ACTIVE);
    });
  });
});

// ---------------------------------------------------------------------------
// Refund workflow
// ---------------------------------------------------------------------------

const REFUND_STATES = Object.values(R);
const REFUND_EDGES = edgeSet([
  [R.REQUESTED, R.APPROVED],
  [R.REQUESTED, R.REJECTED],
  [R.APPROVED, R.SUBMITTING],
  [R.SUBMITTING, R.PENDING],
  [R.SUBMITTING, R.SETTLED],
  [R.SUBMITTING, R.FAILED],
  [R.SUBMITTING, R.APPROVED],
  [R.PENDING, R.PENDING],
  [R.PENDING, R.SETTLED],
  [R.PENDING, R.FAILED],
  [R.PENDING, R.APPROVED],
  [R.FAILED, R.APPROVED],
  [R.FAILED, R.REJECTED],
]);

function makeRefundDb() {
  const purchases = createFakeCollection();
  const refundsCol = createFakeCollection({
    uniqueKey: (d) => (d.status !== "rejected" ? d.purchaseId : null),
  });
  const refundAuditLog = createFakeCollection();
  const db = createFakeDb({
    [COLLECTIONS.purchases]: purchases,
    [COLLECTIONS.refunds]: refundsCol,
    [COLLECTIONS.refundAuditLog]: refundAuditLog,
  });
  return { db, purchases, refundsCol };
}

async function seedRefund(refundsCol, status, overrides = {}) {
  const doc = {
    _id: new ObjectId(),
    purchaseId: String(new ObjectId()),
    materialId: "mat-1",
    buyerAddress: "GBUYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    destination: "GBUYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    assetCode: "USDC",
    amount: 100,
    status,
    retryCount: 0,
    ...overrides,
  };
  await refundsCol.insertOne(doc);
  return doc;
}

const statusOf = (refundsCol, id) => refundsCol.docs.find((d) => String(d._id) === String(id)).status;

const happyDeps = () => ({
  getTreasuryBalanceFn: vi.fn(async () => 10_000),
  buildTransaction: vi.fn(async () => ({ hash: "tx-hash", sequence: "1", transaction: {} })),
  submitTransactionFn: vi.fn(async () => ({ outcome: "confirmed", hash: "tx-hash", ledger: 7 })),
  revokeEntitlementFn: vi.fn(async () => {}),
});

describe("refund state machine", () => {
  it("settled and rejected are the only terminal states", () => {
    expect([...refunds.REFUND_TERMINAL_STATUSES].sort()).toEqual([R.REJECTED, R.SETTLED]);
  });

  it.each(pairs(REFUND_STATES))("isValidRefundTransition(%s -> %s) matches the declared edge set", (from, to) => {
    expect(refunds.isValidRefundTransition(from, to)).toBe(REFUND_EDGES.has(`${from}->${to}`));
  });

  it("rejects unknown statuses", () => {
    expect(refunds.isValidRefundTransition("bogus", R.APPROVED)).toBe(false);
    expect(refunds.isValidRefundTransition(R.REQUESTED, "bogus")).toBe(false);
    expect(refunds.isValidRefundTransition(undefined, undefined)).toBe(false);
  });

  describe.each(REFUND_STATES)("operations on a refund in %s", (status) => {
    it("approveRefund only moves requested", async () => {
      const { db, refundsCol } = makeRefundDb();
      const refund = await seedRefund(refundsCol, status);
      const result = await refunds.approveRefund({ db, refundId: refund._id, actor: "admin" });

      if (status === R.REQUESTED) {
        expect(result.success).toBe(true);
        expect(statusOf(refundsCol, refund._id)).toBe(R.APPROVED);
      } else {
        expect(result).toMatchObject({ success: false, reason: "already_transitioned" });
        expect(statusOf(refundsCol, refund._id)).toBe(status);
      }
    });

    it("rejectRefund only moves requested or failed", async () => {
      const { db, refundsCol } = makeRefundDb();
      const refund = await seedRefund(refundsCol, status);
      const result = await refunds.rejectRefund({ db, refundId: refund._id, actor: "admin" });

      if ([R.REQUESTED, R.FAILED].includes(status)) {
        expect(result.success).toBe(true);
        expect(statusOf(refundsCol, refund._id)).toBe(R.REJECTED);
      } else {
        expect(result).toMatchObject({ success: false, reason: "already_transitioned" });
        expect(statusOf(refundsCol, refund._id)).toBe(status);
      }
    });

    it("retryFailedRefund only moves failed", async () => {
      const { db, refundsCol } = makeRefundDb();
      const refund = await seedRefund(refundsCol, status, { retryCount: 9 });
      const result = await refunds.retryFailedRefund({ db, refundId: refund._id, actor: "admin" });

      if (status === R.FAILED) {
        expect(result.success).toBe(true);
        expect(statusOf(refundsCol, refund._id)).toBe(R.APPROVED);
        expect(refundsCol.docs[0].retryCount).toBe(0);
      } else {
        expect(result).toEqual({ success: false, reason: "not_in_failed_state" });
        expect(statusOf(refundsCol, refund._id)).toBe(status);
      }
    });

    it("processApprovedRefund only claims approved", async () => {
      const { db, refundsCol } = makeRefundDb();
      const refund = await seedRefund(refundsCol, status);
      const deps = happyDeps();
      const result = await refunds.processApprovedRefund({ db, refund, ...deps });

      if (status === R.APPROVED) {
        expect(result.outcome).toBe("settled");
        expect(statusOf(refundsCol, refund._id)).toBe(R.SETTLED);
      } else {
        expect(result).toEqual({ outcome: "already_claimed" });
        expect(deps.submitTransactionFn).not.toHaveBeenCalled();
        expect(statusOf(refundsCol, refund._id)).toBe(status);
      }
    });

    it("finalizeSettlement only settles submitting or pending", async () => {
      const { db, refundsCol } = makeRefundDb();
      const refund = await seedRefund(refundsCol, status);
      const revokeEntitlementFn = vi.fn(async () => {});
      const result = await refunds.finalizeSettlement({
        db,
        refundId: refund._id,
        txHash: "tx",
        revokeEntitlementFn,
      });

      if ([R.SUBMITTING, R.PENDING, R.SETTLED].includes(status)) {
        expect(result.outcome).toBe("settled");
        expect(statusOf(refundsCol, refund._id)).toBe(R.SETTLED);
        expect(revokeEntitlementFn).toHaveBeenCalledTimes(1);
      } else {
        expect(result.outcome).toBe("not_settled");
        expect(statusOf(refundsCol, refund._id)).toBe(status);
        expect(revokeEntitlementFn).not.toHaveBeenCalled();
      }
    });
  });

  describe("terminal states", () => {
    it("settled is immutable under every public operation", async () => {
      const { db, refundsCol } = makeRefundDb();
      const refund = await seedRefund(refundsCol, R.SETTLED, { entitlementRevoked: true, txHash: "tx" });

      await refunds.approveRefund({ db, refundId: refund._id, actor: "a" });
      await refunds.rejectRefund({ db, refundId: refund._id, actor: "a" });
      await refunds.retryFailedRefund({ db, refundId: refund._id, actor: "a" });
      await refunds.processApprovedRefund({ db, refund, ...happyDeps() });
      await refunds.reconcileRefund({ db, refund, getTransactionStatusFn: async () => "failed" });

      expect(statusOf(refundsCol, refund._id)).toBe(R.SETTLED);
    });

    it("rejected is immutable under every public operation", async () => {
      const { db, refundsCol } = makeRefundDb();
      const refund = await seedRefund(refundsCol, R.REJECTED);

      await refunds.approveRefund({ db, refundId: refund._id, actor: "a" });
      await refunds.rejectRefund({ db, refundId: refund._id, actor: "a" });
      await refunds.retryFailedRefund({ db, refundId: refund._id, actor: "a" });
      await refunds.processApprovedRefund({ db, refund, ...happyDeps() });
      await refunds.finalizeSettlement({ db, refundId: refund._id, txHash: "tx", revokeEntitlementFn: vi.fn() });

      expect(statusOf(refundsCol, refund._id)).toBe(R.REJECTED);
    });
  });

  describe("recovery paths", () => {
    it("treasury shortage schedules a retry (submitting -> approved) and counts the attempt", async () => {
      const { db, refundsCol } = makeRefundDb();
      const refund = await seedRefund(refundsCol, R.APPROVED);
      const deps = { ...happyDeps(), getTreasuryBalanceFn: vi.fn(async () => 0) };

      const result = await refunds.processApprovedRefund({ db, refund, ...deps });

      expect(result.outcome).toBe("retry_scheduled");
      expect(statusOf(refundsCol, refund._id)).toBe(R.APPROVED);
      expect(refundsCol.docs[0].retryCount).toBe(1);
      expect(deps.submitTransactionFn).not.toHaveBeenCalled();
    });

    it("exhausted retries fail, an admin retry resets the budget, and the refund then settles", async () => {
      const { db, refundsCol } = makeRefundDb();
      const refund = await seedRefund(refundsCol, R.APPROVED, { retryCount: 1000 });
      const broke = { ...happyDeps(), getTreasuryBalanceFn: vi.fn(async () => 0) };

      expect((await refunds.processApprovedRefund({ db, refund, ...broke })).outcome).toBe("failed");
      expect(statusOf(refundsCol, refund._id)).toBe(R.FAILED);

      expect((await refunds.retryFailedRefund({ db, refundId: refund._id, actor: "admin" })).success).toBe(true);
      expect(statusOf(refundsCol, refund._id)).toBe(R.APPROVED);
      expect(refundsCol.docs[0].retryCount).toBe(0);

      const ok = happyDeps();
      const fresh = refundsCol.docs[0];
      expect((await refunds.processApprovedRefund({ db, refund: fresh, ...ok })).outcome).toBe("settled");
      expect(statusOf(refundsCol, refund._id)).toBe(R.SETTLED);
    });

    it("a failed refund can alternatively be rejected as a terminal denial", async () => {
      const { db, refundsCol } = makeRefundDb();
      const refund = await seedRefund(refundsCol, R.FAILED);
      expect((await refunds.rejectRefund({ db, refundId: refund._id, actor: "admin" })).success).toBe(true);
      expect(statusOf(refundsCol, refund._id)).toBe(R.REJECTED);
      expect((await refunds.retryFailedRefund({ db, refundId: refund._id, actor: "admin" })).success).toBe(false);
    });

    describe("ambiguous submission (submitting -> pending) reconciliation", () => {
      async function pendingRefund(overrides = {}) {
        const ctx = makeRefundDb();
        const refund = await seedRefund(ctx.refundsCol, R.APPROVED);
        const deps = {
          ...happyDeps(),
          submitTransactionFn: vi.fn(async () => ({ outcome: "ambiguous", reason: "timeout" })),
        };
        const result = await refunds.processApprovedRefund({ db: ctx.db, refund, ...deps });
        expect(result.outcome).toBe("pending");
        expect(statusOf(ctx.refundsCol, refund._id)).toBe(R.PENDING);
        Object.assign(ctx.refundsCol.docs[0], overrides);
        return { ...ctx, refund: ctx.refundsCol.docs[0] };
      }

      it("still pending -> stays pending (idempotent re-poll)", async () => {
        const { db, refundsCol, refund } = await pendingRefund();
        const result = await refunds.reconcileRefund({ db, refund, getTransactionStatusFn: async () => "pending" });
        expect(result.outcome).toBe("still_pending");
        expect(statusOf(refundsCol, refund._id)).toBe(R.PENDING);
      });

      it("confirmed on ledger -> settled, entitlement revoked once", async () => {
        const { db, refundsCol, refund } = await pendingRefund();
        const revokeEntitlementFn = vi.fn(async () => {});
        const args = { db, refund, getTransactionStatusFn: async () => "confirmed", revokeEntitlementFn };

        expect((await refunds.reconcileRefund(args)).outcome).toBe("settled");
        expect(statusOf(refundsCol, refund._id)).toBe(R.SETTLED);

        // Re-running reconciliation after settlement must not re-revoke.
        await refunds.reconcileRefund({ ...args, refund: refundsCol.docs[0] });
        expect(revokeEntitlementFn).toHaveBeenCalledTimes(1);
      });

      it("failed on ledger -> back to approved for a fresh attempt", async () => {
        const { db, refundsCol, refund } = await pendingRefund();
        const result = await refunds.reconcileRefund({ db, refund, getTransactionStatusFn: async () => "failed" });
        expect(result.outcome).toBe("retry_scheduled");
        expect(statusOf(refundsCol, refund._id)).toBe(R.APPROVED);
        expect(refundsCol.docs[0].txHash).toBeNull();
      });

      it("never resolved past the timeout -> back to approved", async () => {
        const { db, refundsCol, refund } = await pendingRefund({
          pendingSince: new Date(Date.now() - 60 * 60 * 1000),
        });
        const result = await refunds.reconcileRefund({ db, refund, getTransactionStatusFn: async () => "not_found" });
        expect(result.outcome).toBe("retry_scheduled");
        expect(statusOf(refundsCol, refund._id)).toBe(R.APPROVED);
      });
    });

    it("a worker crash while submitting (no tx checkpoint) recovers to approved", async () => {
      const { db, refundsCol } = makeRefundDb();
      const stuck = await seedRefund(refundsCol, R.SUBMITTING, { txHash: null });
      const result = await refunds.reconcileRefund({ db, refund: stuck, getTransactionStatusFn: vi.fn() });
      expect(result.outcome).toBe("retry_scheduled");
      expect(statusOf(refundsCol, stuck._id)).toBe(R.APPROVED);
    });

    it("settled-but-unconverged refunds converge exactly once after a crash", async () => {
      const { db, refundsCol } = makeRefundDb();
      const refund = await seedRefund(refundsCol, R.SETTLED, { txHash: "tx", entitlementRevoked: false });
      const revokeEntitlementFn = vi.fn(async () => {});

      await refunds.reconcileRefund({ db, refund, revokeEntitlementFn });
      await refunds.reconcileRefund({ db, refund: refundsCol.docs[0], revokeEntitlementFn });

      expect(revokeEntitlementFn).toHaveBeenCalledTimes(1);
      expect(refundsCol.docs[0].entitlementRevoked).toBe(true);
    });
  });

  describe("concurrency", () => {
    it("only one of two parallel workers claims an approved refund", async () => {
      const { db, refundsCol } = makeRefundDb();
      const refund = await seedRefund(refundsCol, R.APPROVED);
      const deps = happyDeps();

      const [a, b] = await Promise.all([
        refunds.processApprovedRefund({ db, refund, ...deps }),
        refunds.processApprovedRefund({ db, refund, ...deps }),
      ]);

      expect([a.outcome, b.outcome].sort()).toEqual(["already_claimed", "settled"]);
      expect(deps.submitTransactionFn).toHaveBeenCalledTimes(1);
    });

    it("approve and reject racing on a requested refund yield exactly one winner", async () => {
      const { db, refundsCol } = makeRefundDb();
      const refund = await seedRefund(refundsCol, R.REQUESTED);

      const [approve, reject] = await Promise.all([
        refunds.approveRefund({ db, refundId: refund._id, actor: "a" }),
        refunds.rejectRefund({ db, refundId: refund._id, actor: "b" }),
      ]);

      expect([approve.success, reject.success].filter(Boolean)).toHaveLength(1);
      expect([R.APPROVED, R.REJECTED]).toContain(statusOf(refundsCol, refund._id));
    });
  });
});

// ---------------------------------------------------------------------------
// Dispute workflow
// ---------------------------------------------------------------------------

const DISPUTE_STATES = Object.values(D);
const DISPUTE_EDGES = edgeSet([
  [D.OPENED, D.REVIEWING],
  [D.REVIEWING, D.APPROVED],
  [D.REVIEWING, D.DENIED],
  [D.APPROVED, D.EXECUTED],
]);

const validBundle = () => ({
  buyerClaim: { reason: "not as described", submittedAt: new Date() },
  creatorMetadata: { materialId: "mat-1", creatorAddress: "GCREATOR", version: 1 },
  purchaseTransaction: { transactionHash: "tx", amount: 100, assetCode: "USDC" },
  accessLogs: [],
  entitlementState: { active: true },
});

function makeDisputeDb() {
  const col = createFakeCollection();
  return { db: createFakeDb({ disputes: col }), col };
}

async function seedDispute(col, status, overrides = {}) {
  const doc = {
    _id: new ObjectId(),
    purchaseId: String(new ObjectId()),
    buyerAddress: "GBUYER",
    status,
    evidenceBundle: validBundle(),
    history: [],
    ...overrides,
  };
  await col.insertOne(doc);
  return doc;
}

describe("dispute state machine", () => {
  it("denied and executed are the only terminal states", () => {
    expect([...disputes.DISPUTE_TERMINAL_STATUSES].sort()).toEqual([D.DENIED, D.EXECUTED]);
  });

  it.each(pairs(DISPUTE_STATES))("isValidDisputeTransition(%s -> %s) matches the declared edge set", (from, to) => {
    expect(disputes.isValidDisputeTransition(from, to)).toBe(DISPUTE_EDGES.has(`${from}->${to}`));
  });

  it.each(pairs(DISPUTE_STATES))("transitionDisputeStatus(%s -> %s) is deterministic", async (from, to) => {
    const { db, col } = makeDisputeDb();
    const dispute = await seedDispute(col, from);
    const result = await disputes.transitionDisputeStatus({ db, disputeId: dispute._id, toStatus: to, actor: "rev" });

    if (DISPUTE_EDGES.has(`${from}->${to}`)) {
      expect(result.success).toBe(true);
      expect(col.docs[0].status).toBe(to);
      expect(col.docs[0].history.at(-1)).toMatchObject({ status: to, actor: "rev" });
    } else {
      expect(result).toMatchObject({
        success: false,
        reason: "invalid_status_transition",
        currentStatus: from,
        targetStatus: to,
      });
      expect(col.docs[0].status).toBe(from);
      expect(col.docs[0].history).toHaveLength(0);
    }
  });

  it("rejects an unknown target and a missing dispute", async () => {
    const { db, col } = makeDisputeDb();
    const dispute = await seedDispute(col, D.OPENED);
    expect(
      await disputes.transitionDisputeStatus({ db, disputeId: dispute._id, toStatus: "bogus", actor: "r" })
    ).toMatchObject({ success: false, reason: "invalid_status_transition" });
    expect(
      await disputes.transitionDisputeStatus({ db, disputeId: new ObjectId(), toStatus: D.REVIEWING, actor: "r" })
    ).toEqual({ success: false, reason: "dispute_not_found" });
  });

  it("refuses approval when the evidence bundle is incomplete, leaving the dispute reviewable", async () => {
    const { db, col } = makeDisputeDb();
    const dispute = await seedDispute(col, D.REVIEWING, { evidenceBundle: { buyerClaim: null } });
    const result = await disputes.transitionDisputeStatus({
      db,
      disputeId: dispute._id,
      toStatus: D.APPROVED,
      actor: "r",
    });
    expect(result.reason).toBe("cannot_approve_missing_evidence");
    expect(col.docs[0].status).toBe(D.REVIEWING);

    // Denial does not require evidence completeness and remains available.
    const denied = await disputes.transitionDisputeStatus({
      db,
      disputeId: dispute._id,
      toStatus: D.DENIED,
      actor: "r",
    });
    expect(denied.success).toBe(true);
  });

  it("walks the full happy path and stamps each actor", async () => {
    const { db, col } = makeDisputeDb();
    const dispute = await seedDispute(col, D.OPENED);
    for (const to of [D.REVIEWING, D.APPROVED, D.EXECUTED]) {
      expect((await disputes.transitionDisputeStatus({ db, disputeId: dispute._id, toStatus: to, actor: to })).success).toBe(
        true
      );
    }
    expect(col.docs[0].history.map((h) => h.status)).toEqual([D.REVIEWING, D.APPROVED, D.EXECUTED]);
    expect(col.docs[0]).toMatchObject({ approvedBy: D.APPROVED, executedBy: D.EXECUTED });
  });

  it("two reviewers racing on the same transition: exactly one wins, history has one entry", async () => {
    const { db, col } = makeDisputeDb();
    const dispute = await seedDispute(col, D.OPENED);

    const results = await Promise.all([
      disputes.transitionDisputeStatus({ db, disputeId: dispute._id, toStatus: D.REVIEWING, actor: "a" }),
      disputes.transitionDisputeStatus({ db, disputeId: dispute._id, toStatus: D.REVIEWING, actor: "b" }),
    ]);

    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.find((r) => !r.success).reason).toBe("concurrent_status_mutation");
    expect(col.docs[0].history).toHaveLength(1);
  });

  describe("refund execution recovery", () => {
    it("a failed refund leaves the dispute approved; a retry executes it exactly once", async () => {
      const { db, col } = makeDisputeDb();
      const dispute = await seedDispute(col, D.APPROVED);
      const executeRefundFn = vi
        .fn()
        .mockResolvedValueOnce({ success: false, reason: "treasury_down" })
        .mockResolvedValue({ success: true, refundId: "r1" });

      const first = await disputes.executeDisputeRefund({ db, disputeId: dispute._id, actor: "sys", executeRefundFn });
      expect(first).toEqual({ success: false, reason: "treasury_down" });
      expect(col.docs[0].status).toBe(D.APPROVED);

      const second = await disputes.executeDisputeRefund({ db, disputeId: dispute._id, actor: "sys", executeRefundFn });
      expect(second.success).toBe(true);
      expect(col.docs[0].status).toBe(D.EXECUTED);

      // Terminal: a replay must not pay out again.
      const replay = await disputes.executeDisputeRefund({ db, disputeId: dispute._id, actor: "sys", executeRefundFn });
      expect(replay).toMatchObject({ success: false, reason: "refund_execution_requires_approved_dispute" });
      expect(executeRefundFn).toHaveBeenCalledTimes(2);
    });

    it.each([D.OPENED, D.REVIEWING, D.DENIED, D.EXECUTED])("refund execution is refused from %s", async (status) => {
      const { db, col } = makeDisputeDb();
      const dispute = await seedDispute(col, status);
      const executeRefundFn = vi.fn();
      const result = await disputes.executeDisputeRefund({ db, disputeId: dispute._id, actor: "s", executeRefundFn });
      expect(result.reason).toBe("refund_execution_requires_approved_dispute");
      expect(executeRefundFn).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Publication saga
// ---------------------------------------------------------------------------

const SAGA_STATES = Object.values(S);
const NON_TERMINAL_STEPS = [S.PENDING, S.UPLOAD_DONE, S.IPFS_PINNED, S.SOROBAN_REGISTERED, S.CHAIN_FINALIZED, S.INDEXED];
const SAGA_FORWARD_EDGES = edgeSet([
  [S.PENDING, S.UPLOAD_DONE],
  [S.UPLOAD_DONE, S.IPFS_PINNED],
  [S.IPFS_PINNED, S.SOROBAN_REGISTERED],
  [S.SOROBAN_REGISTERED, S.CHAIN_FINALIZED],
  [S.CHAIN_FINALIZED, S.INDEXED],
  [S.INDEXED, S.COMPLETE],
]);

async function newSaga() {
  sagaDb = createFakeDb({ publication_sagas: createFakeCollection() });
  const created = await saga.createPublicationSaga(String(new ObjectId()), `key-${Math.random()}`);
  return { created, col: sagaDb.collection("publication_sagas") };
}

async function sagaAt(state) {
  const { created, col } = await newSaga();
  col.docs[0].state = state;
  return { id: created._id, col };
}

describe("publication saga state machine", () => {
  it("complete is the only terminal state; failed is recoverable", () => {
    expect(saga.SAGA_TERMINAL_STATES).toEqual([S.COMPLETE]);
    expect(saga.isValidSagaTransition(S.FAILED, S.PENDING)).toBe(false); // needs a recorded failure point
  });

  it.each(pairs(SAGA_STATES))("isValidSagaTransition(%s -> %s) matches the declared edge set", (from, to) => {
    const expected =
      SAGA_FORWARD_EDGES.has(`${from}->${to}`) ||
      (to === S.FAILED && NON_TERMINAL_STEPS.includes(from));
    expect(saga.isValidSagaTransition(from, to)).toBe(expected);
  });

  it.each(SAGA_STATES)("failed -> %s is allowed only when it equals the recorded failure point", (to) => {
    for (const failedAt of SAGA_STATES) {
      const expected = to === failedAt && NON_TERMINAL_STEPS.includes(failedAt);
      expect(saga.isValidSagaTransition(S.FAILED, to, { failedAt }), `${failedAt}->${to}`).toBe(expected);
    }
  });

  it("walks every forward step, recording a proof for each (state really advances)", async () => {
    const { created, col } = await newSaga();
    let current = S.PENDING;
    while (saga.STATE_TRANSITIONS[current]) {
      const next = saga.STATE_TRANSITIONS[current];
      const updated = await saga.transitionSagaState(created._id, current, { step: current });
      expect(updated.state).toBe(next);
      expect(col.docs[0].stepProofs[current].proof).toEqual({ step: current });
      current = next;
    }
    expect(current).toBe(S.COMPLETE);
  });

  it.each([S.COMPLETE, S.FAILED, "bogus"])("transitionSagaState throws for %s (no forward edge)", async (state) => {
    const { created } = await newSaga();
    await expect(saga.transitionSagaState(created._id, state)).rejects.toThrow(/Invalid state transition/);
  });

  it("a stale transition (wrong current state) is a no-op returning null", async () => {
    const { id, col } = await sagaAt(S.IPFS_PINNED);
    expect(await saga.transitionSagaState(id, S.PENDING)).toBeNull();
    expect(col.docs[0].state).toBe(S.IPFS_PINNED);
  });

  it("duplicate/racing advances of the same step: one winner, one null", async () => {
    const { id, col } = await sagaAt(S.UPLOAD_DONE);
    const [a, b] = await Promise.all([
      saga.transitionSagaState(id, S.UPLOAD_DONE, { who: "a" }),
      saga.transitionSagaState(id, S.UPLOAD_DONE, { who: "b" }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(col.docs[0].state).toBe(S.IPFS_PINNED);
  });

  it.each(NON_TERMINAL_STEPS)("failSagaStep from %s records the failure point", async (state) => {
    const { id, col } = await sagaAt(state);
    const failed = await saga.failSagaStep(id, state, "boom");
    expect(failed.state).toBe(S.FAILED);
    expect(failed.lastError).toMatchObject({ failedAt: state, reason: "boom" });
    expect(col.docs[0].retries).toBe(1);
  });

  it("failSagaStep cannot fail a completed saga or overwrite an existing failure point", async () => {
    const done = await sagaAt(S.COMPLETE);
    expect(await saga.failSagaStep(done.id, S.COMPLETE, "late")).toBeNull();
    expect(done.col.docs[0].state).toBe(S.COMPLETE);

    const { id, col } = await sagaAt(S.IPFS_PINNED);
    await saga.failSagaStep(id, S.IPFS_PINNED, "first");
    expect(await saga.failSagaStep(id, S.INDEXED, "second")).toBeNull();
    expect(col.docs[0].lastError).toMatchObject({ failedAt: S.IPFS_PINNED, reason: "first" });
  });

  it("completeSaga only promotes an indexed saga", async () => {
    for (const state of SAGA_STATES.filter((s) => s !== S.INDEXED)) {
      const { id, col } = await sagaAt(state);
      expect(await saga.completeSaga(id), state).toBeNull();
      expect(col.docs[0].state).toBe(state);
    }
    const { id } = await sagaAt(S.INDEXED);
    expect((await saga.completeSaga(id)).state).toBe(S.COMPLETE);
  });

  describe("recovery", () => {
    it.each(NON_TERMINAL_STEPS)("a saga failed at %s resumes at that step and can finish", async (failedAt) => {
      const { id, col } = await sagaAt(failedAt);
      await saga.failSagaStep(id, failedAt, "transient");

      const resumed = await saga.retrySagaFromFailure(id);
      expect(resumed.state).toBe(failedAt);

      // Drive the remainder to completion.
      let current = failedAt;
      while (saga.STATE_TRANSITIONS[current]) {
        current = (await saga.transitionSagaState(id, current)).state;
      }
      expect(current).toBe(S.COMPLETE);
      expect(col.docs[0].state).toBe(S.COMPLETE);
    });

    it("refuses to retry sagas that are not failed", async () => {
      for (const state of SAGA_STATES.filter((s) => s !== S.FAILED)) {
        const { id, col } = await sagaAt(state);
        expect(await saga.retrySagaFromFailure(id), state).toBeNull();
        expect(col.docs[0].state).toBe(state);
      }
    });

    it("refuses to retry a failed saga with no usable failure point", async () => {
      for (const lastError of [null, { failedAt: S.COMPLETE }, { failedAt: S.FAILED }, { failedAt: "bogus" }]) {
        const { id, col } = await sagaAt(S.FAILED);
        col.docs[0].lastError = lastError;
        expect(await saga.retrySagaFromFailure(id), JSON.stringify(lastError)).toBeNull();
        expect(col.docs[0].state).toBe(S.FAILED);
      }
    });

    it("refuses to resume after compensation rolled external resources back", async () => {
      const { id, col } = await sagaAt(S.CHAIN_FINALIZED);
      col.docs[0].stepProofs = {
        [S.IPFS_PINNED]: { proof: { cid: "bafy" } },
        [S.SOROBAN_REGISTERED]: { proof: { contractId: "C1" } },
        [S.CHAIN_FINALIZED]: { proof: { txHash: "tx" } },
      };
      await saga.failSagaStep(id, S.CHAIN_FINALIZED, "chain down");

      const compensation = await saga.compensateSaga(col.docs[0]);
      expect(compensation.rollbacks.map((r) => r.action)).toEqual(["unpin_ipfs", "mark_unregistered", "mark_draft"]);
      expect(col.docs[0].state).toBe(S.FAILED);
      expect(await saga.retrySagaFromFailure(id)).toBeNull();
    });

    it("compensation is refused for a completed saga and leaves it complete", async () => {
      const { id, col } = await sagaAt(S.COMPLETE);
      await expect(saga.compensateSaga(col.docs[0])).rejects.toThrow(/already complete/);
      expect(col.docs.find((d) => String(d._id) === String(id)).state).toBe(S.COMPLETE);
    });

    it("stalled sagas exclude complete and failed ones", async () => {
      const { col } = await newSaga();
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      col.docs[0].state = S.IPFS_PINNED;
      col.docs[0].updatedAt = old;
      for (const state of [S.COMPLETE, S.FAILED]) {
        await col.insertOne({ state, updatedAt: old, materialId: new ObjectId(), idempotencyKey: state });
      }
      const stalled = await saga.getStalledSagas();
      expect(stalled.map((s) => s.state)).toEqual([S.IPFS_PINNED]);
    });
  });
});

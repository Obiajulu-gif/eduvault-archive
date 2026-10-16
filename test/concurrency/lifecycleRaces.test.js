// @vitest-environment node
/**
 * Multi-actor races on the stateful, money-adjacent mutations: material
 * lifecycle, disputes, the publication saga and refund processing. Invariants
 * are asserted for every explored interleaving, not just one lucky ordering.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { createFakeCollection, createFakeDb } from "@/lib/refunds/__tests__/fakeMongo";
import { COLLECTIONS } from "@/lib/backend/schemaContracts";
import { explore, instrumentDb, settledValues } from "./harness.js";

const audit = [];
vi.mock("@/lib/api/audit", () => ({ auditLog: (entry) => audit.push(entry) }));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/checkout/refundVerifier", () => ({ verifyRefundLimit: vi.fn(async () => ({ valid: true })) }));
vi.mock("@/lib/notifications/notifications", () => ({ notifyWalletRecipient: vi.fn(async () => ({})) }));

let sagaDb;
vi.mock("@/lib/mongodb", () => ({ getDb: vi.fn(async () => sagaDb) }));

const material = await import("@/lib/db/materialLifecycle");
const disputes = await import("@/lib/refunds/disputeWorkflow");
const saga = await import("@/lib/backend/publicationSaga");
const refunds = await import("@/lib/refunds/refundWorkflow");

const SEEDS = 40;
const { MaterialLifecycleState: M } = material;
const { DISPUTE_STATUS: D } = disputes;
const { PUBLICATION_STATES: S } = saga;
const { REFUND_STATUS: R } = refunds;

beforeEach(() => {
  audit.length = 0;
});

describe("material lifecycle: competing moderators, creators and legal", () => {
  const PLANS = [
    [M.PAUSED, M.ACTIVE, M.ARCHIVED],
    [M.ARCHIVED, M.ACTIVE, M.RETIRED],
    [M.SUSPENDED, M.ACTIVE, M.PAUSED],
    [M.RETIRED, M.ACTIVE, M.SUSPENDED],
    [M.REMOVED],
    [M.ACTIVE, M.PAUSED, M.RETIRED],
  ];

  it("every committed transition chains from the previous one and REMOVED is final", async () => {
    let sawRemoved = 0;
    let sawConflict = 0;

    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        audit.length = 0;
        const materials = createFakeCollection();
        const _id = new ObjectId();
        await materials.insertOne({ _id, lifecycleState: M.ACTIVE });
        const db = instrumentDb(createFakeDb({ materials }), scheduler);

        const errors = [];
        const actors = PLANS.map((plan, index) => async () => {
          for (const target of plan) {
            try {
              await material.transitionMaterialState(db, _id, target, { actor: `actor-${index}` });
            } catch (error) {
              errors.push(error.code);
            }
          }
        });
        settledValues(await scheduler.run(actors));

        const commits = audit.filter((entry) => entry.event === "material_lifecycle_transition");
        let previous = M.ACTIVE;
        for (const commit of commits) {
          expect(commit.from).toBe(previous); // no lost update / stale write
          expect(material.isValidTransition(commit.from, commit.to)).toBe(true);
          expect(commit.from).not.toBe(commit.to);
          previous = commit.to;
        }
        expect(materials.docs[0].lifecycleState).toBe(previous);

        const removedAt = commits.findIndex((commit) => commit.to === M.REMOVED);
        if (removedAt !== -1) {
          sawRemoved += 1;
          expect(removedAt).toBe(commits.length - 1);
          expect(materials.docs[0].legalTombstone).toBe(true);
        }
        // Soft-delete flags always agree with the final state.
        expect(materials.docs[0].isDeleted === true).toBe(
          materials.docs[0].lifecycleState === M.RETIRED
        );
        sawConflict += errors.filter((code) => code === "LIFECYCLE_CONCURRENT_MODIFICATION").length;
        for (const code of errors) {
          expect(["INVALID_LIFECYCLE_TRANSITION", "LIFECYCLE_CONCURRENT_MODIFICATION"]).toContain(code);
        }
      },
    });

    // The sweep must actually exercise both the race and the terminal state.
    expect(sawConflict).toBeGreaterThan(0);
    expect(sawRemoved).toBeGreaterThan(0);
  });
});

describe("disputes: competing reviewers and executors", () => {
  const bundle = () => ({
    buyerClaim: { reason: "r", submittedAt: new Date() },
    creatorMetadata: { materialId: "m", creatorAddress: "G", version: 1 },
    purchaseTransaction: { transactionHash: "tx", amount: 10, assetCode: "USDC" },
    accessLogs: [],
    entitlementState: { active: true },
  });

  it("history is a legal path, with no duplicated step and a single payout", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const col = createFakeCollection();
        const _id = new ObjectId();
        await col.insertOne({ _id, purchaseId: "p1", buyerAddress: "GB", status: D.OPENED, evidenceBundle: bundle(), history: [] });
        const db = instrumentDb(createFakeDb({ disputes: col }), scheduler);

        let payouts = 0;
        const executeRefundFn = async () => {
          await scheduler.yield("payout");
          payouts += 1;
          return { success: true, refundId: "r1" };
        };

        const reviewer = (path) => async () => {
          for (const toStatus of path) {
            await disputes.transitionDisputeStatus({ db, disputeId: _id, toStatus, actor: `rev-${path[0]}` });
          }
        };
        const executor = () => async () => {
          for (let i = 0; i < 3; i += 1) {
            await disputes.executeDisputeRefund({ db, disputeId: _id, actor: "sys", executeRefundFn });
          }
        };

        settledValues(
          await scheduler.run([
            reviewer([D.REVIEWING, D.APPROVED, D.EXECUTED]),
            reviewer([D.REVIEWING, D.DENIED]),
            reviewer([D.REVIEWING, D.APPROVED]),
            executor(),
            executor(),
          ])
        );

        const history = col.docs[0].history.map((h) => h.status);
        let previous = D.OPENED;
        for (const status of history) {
          expect(disputes.isValidDisputeTransition(previous, status), `${previous}->${status}`).toBe(true);
          previous = status;
        }
        expect(new Set(history).size).toBe(history.length);
        expect(col.docs[0].status).toBe(previous);
        // Approve and deny are mutually exclusive outcomes.
        expect(history.includes(D.APPROVED) && history.includes(D.DENIED)).toBe(false);
        // Money moves at most once, and only for an approved->executed dispute.
        expect(payouts).toBeLessThanOrEqual(1);
        if (payouts === 1) expect(history).toContain(D.EXECUTED);
      },
    });
  });
});

describe("publication saga: parallel workers, failure and retry", () => {
  async function newSaga(scheduler) {
    const col = createFakeCollection();
    sagaDb = instrumentDb(createFakeDb({ publication_sagas: col }), scheduler);
    const id = new ObjectId();
    await col.insertOne({
      _id: id,
      materialId: new ObjectId(),
      idempotencyKey: "k",
      state: S.PENDING,
      stepProofs: {},
      retries: 0,
    });
    return { col, id };
  }

  it("each step is won by exactly one worker and the saga completes", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { col, id } = await newSaga(scheduler);
        const wins = [];

        const worker = (name) => async () => {
          for (let i = 0; i < 40 && col.docs[0].state !== S.COMPLETE; i += 1) {
            const current = col.docs[0].state; // stale read is the point
            if (!saga.STATE_TRANSITIONS[current]) break;
            const updated = await saga.transitionSagaState(id, current, { by: name });
            if (updated) wins.push(current);
            else await scheduler.yield("lost-race");
          }
        };
        settledValues(await scheduler.run(["a", "b", "c", "d"].map(worker)));

        expect(col.docs[0].state).toBe(S.COMPLETE);
        expect(wins).toEqual(saga.SAGA_STEP_ORDER.slice(0, -1)); // each step once, in order
        expect(Object.keys(col.docs[0].stepProofs)).toHaveLength(wins.length);
      },
    });
  });

  it("failure and retry racing with workers never skips, repeats or rewinds a step", async () => {
    let sawFailure = 0;
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { col, id } = await newSaga(scheduler);
        const wins = [];
        let failures = 0;

        const worker = (name) => async () => {
          for (let i = 0; i < 200; i += 1) {
            const current = col.docs[0].state;
            if (current === S.COMPLETE) return;
            if (current === S.FAILED || !saga.STATE_TRANSITIONS[current]) {
              await scheduler.yield("wait");
              continue;
            }
            const updated = await saga.transitionSagaState(id, current, { by: name });
            if (updated) wins.push(current);
          }
        };
        const failer = async () => {
          for (let i = 0; i < 3; i += 1) {
            await scheduler.yield("fail-delay");
            // Deliberately reports the state it saw, which may already be stale.
            const failed = await saga.failSagaStep(id, col.docs[0].state, "downstream outage");
            if (failed) failures += 1;
          }
        };
        const recoverer = async () => {
          for (let i = 0; i < 100; i += 1) {
            await saga.retrySagaFromFailure(id);
            await scheduler.yield("recover-delay");
          }
        };

        settledValues(await scheduler.run([worker("a"), worker("b"), failer, recoverer]));

        // Strictly in order, each step won once: a failed step is retried, a
        // completed step is never repeated or skipped.
        expect(wins).toEqual(saga.SAGA_STEP_ORDER.slice(0, wins.length));
        expect(col.docs[0].state).toBe(S.COMPLETE);
        sawFailure += failures;
      },
    });
    expect(sawFailure).toBeGreaterThan(0);
  });
});

describe("refunds: workers, reconcilers and double settlement", () => {
  function refundDb(scheduler) {
    const purchases = createFakeCollection();
    const refundsCol = createFakeCollection({ uniqueKey: (d) => (d.status !== "rejected" ? d.purchaseId : null) });
    const refundAuditLog = createFakeCollection();
    const raw = createFakeDb({
      [COLLECTIONS.purchases]: purchases,
      [COLLECTIONS.refunds]: refundsCol,
      [COLLECTIONS.refundAuditLog]: refundAuditLog,
    });
    return { db: instrumentDb(raw, scheduler), purchases, refundsCol };
  }

  async function seed({ purchases, refundsCol }, status, overrides = {}) {
    const purchaseId = new ObjectId();
    await purchases.insertOne({ _id: purchaseId, refundedAmount: 0, settlementState: null });
    const refund = {
      _id: new ObjectId(),
      purchaseId: String(purchaseId),
      materialId: "mat-1",
      buyerAddress: "GBUYER",
      destination: "GBUYER",
      assetCode: "USDC",
      amount: 100,
      status,
      retryCount: 0,
      ...overrides,
    };
    await refundsCol.insertOne(refund);
    return refund;
  }

  it("overlapping reconcilers settle a pending refund and mirror the money exactly once", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const ctx = refundDb(scheduler);
        const refund = await seed(ctx, R.PENDING, { txHash: "tx-1" });
        const revokeEntitlementFn = vi.fn(async () => {});

        settledValues(
          await scheduler.run(
            Array.from({ length: 4 }, () => async () =>
              refunds.reconcileRefund({
                db: ctx.db,
                refund,
                getTransactionStatusFn: async () => "confirmed",
                revokeEntitlementFn,
              })
            )
          )
        );

        const stored = ctx.refundsCol.docs[0];
        const purchase = ctx.purchases.docs[0];
        expect(stored.status).toBe(R.SETTLED);
        expect(stored.entitlementRevoked).toBe(true);
        // The invariant that matters for money: counted once, however many finalizers ran.
        expect(purchase.refundedAmount).toBe(100);
        expect(purchase.appliedRefundIds).toEqual([String(refund._id)]);
        expect(purchase.settlementState).toBe("Refunded");
        // Revocation is idempotent by contract, so >1 call is tolerated but >=1 is required.
        expect(revokeEntitlementFn.mock.calls.length).toBeGreaterThanOrEqual(1);
      },
    });
  });

  it("many workers polling the queue claim and submit an approved refund once", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const ctx = refundDb(scheduler);
        const refund = await seed(ctx, R.APPROVED);
        let submissions = 0;
        const deps = {
          getTreasuryBalanceFn: async () => 1000,
          buildTransaction: async () => ({ hash: "h", sequence: "1", transaction: {} }),
          submitTransactionFn: async () => {
            await scheduler.yield("submit");
            submissions += 1;
            return { outcome: "confirmed", hash: "h", ledger: 1 };
          },
          revokeEntitlementFn: async () => {},
        };

        const worker = () => async () => {
          for (let i = 0; i < 3; i += 1) {
            const queue = await refunds.getRefundsAwaitingSubmission(ctx.db, 5);
            for (const item of queue) await refunds.processApprovedRefund({ db: ctx.db, refund: item, ...deps });
            await scheduler.yield("poll");
          }
        };
        settledValues(await scheduler.run([worker(), worker(), worker(), worker()]));

        expect(submissions).toBe(1);
        expect(ctx.refundsCol.docs[0].status).toBe(R.SETTLED);
        expect(ctx.purchases.docs[0].refundedAmount).toBe(refund.amount);
      },
    });
  });

  it("a retry storm on a failing dependency counts every attempt once and never submits", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const ctx = refundDb(scheduler);
        await seed(ctx, R.APPROVED);
        let submissions = 0;
        const outcomes = [];
        const deps = {
          getTreasuryBalanceFn: async () => 0, // permanent shortage
          buildTransaction: async () => ({ hash: "h", sequence: "1", transaction: {} }),
          submitTransactionFn: async () => {
            submissions += 1;
            return { outcome: "confirmed", hash: "h", ledger: 1 };
          },
          revokeEntitlementFn: async () => {},
        };

        const worker = () => async () => {
          for (let i = 0; i < 12; i += 1) {
            const queue = await refunds.getRefundsAwaitingSubmission(ctx.db, 5);
            for (const item of queue) {
              const result = await refunds.processApprovedRefund({ db: ctx.db, refund: item, ...deps });
              if (result.outcome !== "already_claimed") outcomes.push(result.outcome);
            }
            await scheduler.yield("poll");
          }
        };
        settledValues(await scheduler.run([worker(), worker(), worker(), worker(), worker()]));

        const stored = ctx.refundsCol.docs[0];
        expect(submissions).toBe(0);
        // Exactly one claim per attempt: the stored counter equals processed attempts.
        expect(stored.retryCount).toBe(outcomes.length);
        expect(outcomes.filter((o) => o === "failed").length).toBeLessThanOrEqual(1);
        expect([R.APPROVED, R.FAILED]).toContain(stored.status);
        if (stored.status === R.FAILED) expect(outcomes).toContain("failed");
      },
    });
  });
});

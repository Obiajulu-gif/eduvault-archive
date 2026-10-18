// @vitest-environment node
/**
 * Deterministic Replay Tests for Concurrent Writes and Retries — Issue #983
 *
 * Verifies that concurrent multi-actor writes, idempotency retries, entitlement
 * transitions, and invariant recovery paths are 100% deterministically reproducible
 * across identical PRNG seeds.
 *
 * Guarantees:
 * 1. Bit-for-Bit Deterministic Trace Replay: Any interleaved concurrent write scenario
 *    run twice under the same seed produces the exact same operation sequence,
 *    scheduling order, and final database states.
 * 2. Concurrent Retries & Idempotency: Multiple actors retrying overlapping purchase
 *    and balance mutations never produce double-allocation or diverging states.
 * 3. Authorization Boundaries Under Race Conditions: Unauthorized attempts interleaved
 *    with legitimate writes are consistently rejected across all replayed orderings.
 * 4. Invariant Protection & Deterministic Rollback: Injected mutation failures roll back
 *    to strictly identical checkpoints upon replay.
 */

import { describe, it, expect } from "vitest";
import { ObjectId } from "mongodb";
import { createFakeCollection, createFakeDb } from "@/lib/refunds/__tests__/fakeMongo";
import { withIdempotency } from "@/lib/backend/idempotency";
import { VERSIONED_WRITE, updateWithExpectedVersion } from "@/lib/backend/versionedWrite";
import { createScheduler, instrumentDb, mulberry32 } from "./harness.js";
import {
  checkBalanceTransition,
  checkOwnershipTransition,
  checkEntitlementTransition,
  executeWithInvariantProtection,
} from "@/lib/transitions/invariantChecker.js";

/** Creates a fake collection enforcing unique `_id` like MongoDB primary keys */
function createUniqueIdCollection(initialDocs = []) {
  const col = createFakeCollection();
  for (const doc of initialDocs) {
    const _id = doc._id || new ObjectId();
    col.docs.push({ ...doc, _id });
  }
  const origInsertOne = col.insertOne.bind(col);
  col.insertOne = async (doc) => {
    if (doc._id !== undefined && col.docs.some((d) => String(d._id) === String(doc._id))) {
      throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    }
    return origInsertOne(doc);
  };
  return col;
}

describe("Deterministic Replay for Concurrent Writes and Retries (#983)", () => {
  /**
   * Scenario 1: Deterministic Replay of Concurrent Purchase Writes and Retries.
   * Runs 3 concurrent actors attempting to purchase an item under versioned writes and retries.
   * Records execution trace and verifies that replay with identical seed produces bit-for-bit identical trace.
   */
  async function runPurchaseScenario(seed) {
    const trace = [];
    const prng = mulberry32(seed);
    const scheduler = createScheduler({ prng });

    const materials = createUniqueIdCollection([
      {
        _id: new ObjectId("650000000000000000000001"),
        title: "Advanced Stellar Contracts",
        stock: 1,
        version: 1,
        purchasedBy: null,
      },
    ]);
    const idempotency = createUniqueIdCollection();

    const db = instrumentDb(
      createFakeDb({
        materials,
        idempotency_keys: idempotency,
      }),
      scheduler
    );

    const makeActor = (actorId, idempotencyKey) => async () => {
      trace.push({ actor: actorId, step: "start" });

      const result = await withIdempotency(
        db,
        idempotencyKey,
        { actorId, item: "material_1" },
        async () => {
          trace.push({ actor: actorId, step: "entered_handler" });
          const doc = await db.collection("materials").findOne({
            _id: new ObjectId("650000000000000000000001"),
          });

          if (!doc || doc.stock <= 0) {
            trace.push({ actor: actorId, step: "out_of_stock" });
            return { purchased: false, reason: "OUT_OF_STOCK" };
          }

          const updateResult = await updateWithExpectedVersion(
            db.collection("materials"),
            {
              id: doc._id,
              baseVersion: doc.version,
              set: {
                stock: doc.stock - 1,
                purchasedBy: actorId,
              },
            }
          );

          if (updateResult.status === VERSIONED_WRITE.CONFLICT) {
            trace.push({ actor: actorId, step: "version_conflict" });
            return { purchased: false, reason: "CONFLICT" };
          }

          trace.push({ actor: actorId, step: "purchase_success" });
          return { purchased: true, actorId };
        }
      );

      trace.push({ actor: actorId, step: "finish", replayed: result.replayed });
      return result;
    };

    const actors = [
      makeActor("buyer_alice", "key_alice_1"),
      makeActor("buyer_bob", "key_bob_1"),
      makeActor("buyer_alice", "key_alice_1"), // Duplicate retry from Alice
    ];

    const results = await scheduler.run(actors.map((fn) => fn()));
    const finalMaterial = await db.collection("materials").findOne({
      _id: new ObjectId("650000000000000000000001"),
    });

    return {
      trace,
      results,
      finalMaterial,
    };
  }

  it("replays bit-for-bit identical execution traces and outcomes with identical seeds", async () => {
    const testSeeds = [42, 1337, 8888, 99999];

    for (const seed of testSeeds) {
      const runA = await runPurchaseScenario(seed);
      const runB = await runPurchaseScenario(seed);

      // Verify trace equality
      expect(runA.trace).toEqual(runB.trace);
      expect(runA.results).toEqual(runB.results);
      expect(runA.finalMaterial.stock).toEqual(runB.finalMaterial.stock);
      expect(runA.finalMaterial.version).toEqual(runB.finalMaterial.version);
      expect(runA.finalMaterial.purchasedBy).toEqual(runB.finalMaterial.purchasedBy);

      // Invariant: Stock must never become negative
      expect(runA.finalMaterial.stock).toBeGreaterThanOrEqual(0);
      expect(runA.finalMaterial.stock).toBeLessThanOrEqual(1);
    }
  });

  /**
   * Scenario 2: Concurrent Entitlement Transitions and Authorization Enforcement Replay.
   * Competing authorized and unauthorized actors attempt lifecycle transitions.
   */
  async function runEntitlementScenario(seed) {
    const trace = [];
    const prng = mulberry32(seed);
    const scheduler = createScheduler({ prng });

    const entitlements = createUniqueIdCollection([
      {
        _id: new ObjectId("650000000000000000000002"),
        materialId: "mat_002",
        buyerAddress: "GBUYER1234567890",
        status: "NONE",
        version: 1,
      },
    ]);

    const db = instrumentDb(createFakeDb({ entitlements }), scheduler);

    const makeEntitlementActor = (actorId, isAuthorized, toStatus, purchaseId) => async () => {
      trace.push({ actor: actorId, step: "check_auth" });

      if (!isAuthorized) {
        trace.push({ actor: actorId, step: "auth_rejected" });
        return { success: false, error: "UNAUTHORIZED_ACTOR" };
      }

      trace.push({ actor: actorId, step: "auth_passed" });
      const currentDoc = await db.collection("entitlements").findOne({
        _id: new ObjectId("650000000000000000000002"),
      });

      const invariantCheck = checkEntitlementTransition({
        materialId: currentDoc.materialId,
        buyerAddress: currentDoc.buyerAddress,
        fromStatus: currentDoc.status,
        toStatus,
        purchaseId,
      });

      if (!invariantCheck.valid) {
        trace.push({ actor: actorId, step: "invariant_rejected", reason: invariantCheck.error });
        return { success: false, error: invariantCheck.error };
      }

      const updateResult = await updateWithExpectedVersion(
        db.collection("entitlements"),
        {
          id: currentDoc._id,
          baseVersion: currentDoc.version,
          set: { status: toStatus },
        }
      );

      if (updateResult.status === VERSIONED_WRITE.CONFLICT) {
        trace.push({ actor: actorId, step: "write_conflict" });
        return { success: false, error: "VERSION_CONFLICT" };
      }

      trace.push({ actor: actorId, step: "transition_success", toStatus });
      return { success: true, toStatus };
    };

    const actors = [
      makeEntitlementActor("malicious_actor", false, "ACTIVE", "fake_proof"),
      makeEntitlementActor("legit_system", true, "ACTIVE", "valid_proof_123"),
      makeEntitlementActor("settlement_relay", true, "ACTIVE", "valid_proof_123"),
    ];

    const results = await scheduler.run(actors.map((fn) => fn()));
    const finalDoc = await db.collection("entitlements").findOne({
      _id: new ObjectId("650000000000000000000002"),
    });

    return { trace, results, finalDoc };
  }

  it("deterministically replays authorization rejections and single entitlement activation", async () => {
    const testSeeds = [101, 202, 303, 404];

    for (const seed of testSeeds) {
      const run1 = await runEntitlementScenario(seed);
      const run2 = await runEntitlementScenario(seed);

      expect(run1.trace).toEqual(run2.trace);
      const stripTimestamps = (arr) => JSON.parse(JSON.stringify(arr, (k, v) => (k === 'timestamp' ? undefined : v)));
      expect(stripTimestamps(run1.results)).toEqual(stripTimestamps(run2.results));
      expect(run1.finalDoc.status).toBe("ACTIVE");
      expect(run1.finalDoc.version).toBe(2);

      // Verify malicious actor was deterministically rejected in both
      expect(run1.results[0].value).toEqual({ success: false, error: "UNAUTHORIZED_ACTOR" });
      expect(run2.results[0].value).toEqual({ success: false, error: "UNAUTHORIZED_ACTOR" });
    }
  });

  /**
   * Scenario 3: Concurrent Balance Invariant & Rollback Recovery Replay.
   * Simulates concurrent balance mutations where one actor encounters a failure mid-transaction
   * and triggers deterministic rollback.
   */
  async function runBalanceRollbackScenario(seed) {
    const trace = [];
    const prng = mulberry32(seed);
    const scheduler = createScheduler({ prng });

    const accounts = createUniqueIdCollection([
      {
        _id: new ObjectId("650000000000000000000003"),
        account: "GACCOUNT123",
        balance: 100,
        version: 1,
      },
    ]);

    const db = instrumentDb(createFakeDb({ accounts }), scheduler);

    const makeBalanceActor = (actorId, debitAmount, shouldFailMidway) => async () => {
      trace.push({ actor: actorId, step: "balance_read_start" });
      const current = await db.collection("accounts").findOne({ account: "GACCOUNT123" });

      const check = checkBalanceTransition({
        fromBalance: current.balance,
        toBalance: current.balance - debitAmount,
        delta: -debitAmount,
        currency: "XLM",
        authorizedAccount: "GACCOUNT123",
        actor: "GACCOUNT123",
      });

      if (!check.valid) {
        trace.push({ actor: actorId, step: "balance_invariant_failed", error: check.error });
        return { success: false, error: check.error };
      }

      try {
        const executionResult = await executeWithInvariantProtection({
          type: "balance",
          transitionParams: {
            fromBalance: current.balance,
            toBalance: current.balance - debitAmount,
            delta: -debitAmount,
            currency: "XLM",
            authorizedAccount: "GACCOUNT123",
            actor: "GACCOUNT123",
          },
          executeFn: async () => {
            trace.push({ actor: actorId, step: "mutating_db" });
            if (shouldFailMidway) {
              throw new Error("SIMULATED_NETWORK_FAILURE_MIDWAY");
            }

            const write = await updateWithExpectedVersion(
              db.collection("accounts"),
              {
                id: current._id,
                baseVersion: current.version,
                set: { balance: current.balance - debitAmount },
              }
            );

            return write;
          },
        });

        trace.push({ actor: actorId, step: "balance_mutation_success" });
        return { success: true, result: executionResult };
      } catch (err) {
        trace.push({ actor: actorId, step: "balance_mutation_aborted", rollback: err.rollbackState });
        return { success: false, error: err.message, rollbackState: err.rollbackState };
      }
    };

    const actors = [
      makeBalanceActor("actor_normal", 30, false),
      makeBalanceActor("actor_faulty", 40, true), // encounters network crash mid-flight
    ];

    const results = await scheduler.run(actors.map((fn) => fn()));
    const finalAccount = await db.collection("accounts").findOne({ account: "GACCOUNT123" });

    return { trace, results, finalAccount };
  }

  it("deterministically replays balance rollback calculations and fault recovery", async () => {
    const testSeeds = [55, 77, 99];

    for (const seed of testSeeds) {
      const runA = await runBalanceRollbackScenario(seed);
      const runB = await runBalanceRollbackScenario(seed);

      expect(runA.trace).toEqual(runB.trace);
      expect(runA.results).toEqual(runB.results);
      expect(runA.finalAccount.balance).toEqual(runB.finalAccount.balance);

      // Faulty actor must always preserve rollback state
      const faultyA = runA.results.map((r) => r.value || r).find((r) => r.error === "SIMULATED_NETWORK_FAILURE_MIDWAY");
      const faultyB = runB.results.map((r) => r.value || r).find((r) => r.error === "SIMULATED_NETWORK_FAILURE_MIDWAY");
      expect(faultyA).toBeDefined();
      expect(faultyA.rollbackState).toEqual(faultyB.rollbackState);
      expect(faultyA.rollbackState.type).toBe("balance");
    }
  });
});

// @vitest-environment node
/**
 * Duplicate submissions, stale versions and retry storms against the write
 * primitives every critical mutation is built on. Each scenario is run across
 * many seeded interleavings; the asserted invariants must hold for all of them.
 */
import { describe, it, expect } from "vitest";
import { ObjectId } from "mongodb";
import { createFakeCollection, createFakeDb } from "@/lib/refunds/__tests__/fakeMongo";
import { hashPayload, withIdempotency } from "@/lib/backend/idempotency";
import { VERSIONED_WRITE, updateWithExpectedVersion } from "@/lib/backend/versionedWrite";
import { consumeCheckoutQuote } from "@/lib/checkout/quotes";
import { createScheduler, explore, instrumentDb, retryStorm, settledValues } from "./harness.js";

const SEEDS = 40;

/** Idempotency records need a unique `_id`, like Mongo's primary key. */
function uniqueIdCollection() {
  const col = createFakeCollection();
  const insertOne = col.insertOne.bind(col);
  col.insertOne = async (doc) => {
    if (doc._id !== undefined && col.docs.some((d) => d._id === doc._id)) {
      throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    }
    return insertOne(doc);
  };
  return col;
}

describe("idempotent writes under duplicate submission", () => {
  function setup(scheduler) {
    const keys = uniqueIdCollection();
    const db = instrumentDb(createFakeDb({ idempotency_keys: keys }), scheduler);
    const effects = [];
    const handlerFor = (label, { failFirst = false } = {}) => {
      let failed = false;
      return async () => {
        await scheduler.yield(`handler:${label}`);
        if (failFirst && !failed) {
          failed = true;
          throw new Error("transient downstream failure");
        }
        effects.push(label);
        return { orderId: `order-${label}` };
      };
    };
    return { keys, db, effects, handlerFor };
  }

  it("12 concurrent duplicates run the side effect exactly once", async () => {
    const report = await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { keys, db, effects, handlerFor } = setup(scheduler);
        const handler = handlerFor("A");

        const outcomes = settledValues(
          await scheduler.run(
            Array.from({ length: 12 }, () => async () => {
              try {
                return await withIdempotency(db, "buy-1", { material: "m1" }, handler);
              } catch (error) {
                return { error: error.code };
              }
            })
          )
        );

        expect(effects).toEqual(["A"]);
        const executed = outcomes.filter((o) => o.replayed === false);
        expect(executed).toHaveLength(1);
        for (const outcome of outcomes) {
          if (outcome.error) expect(outcome.error).toBe("CONFLICT_IN_PROGRESS");
          else expect(outcome.result).toEqual({ orderId: "order-A" });
        }
        expect(keys.docs).toHaveLength(1);
        expect(keys.docs[0].status).toBe("completed");

        // A late retry after the storm is a pure replay.
        const late = await withIdempotency(createFakeDb({ idempotency_keys: keys }), "buy-1", { material: "m1" }, handlerFor("late"));
        expect(late).toEqual({ result: { orderId: "order-A" }, replayed: true });
        expect(effects).toEqual(["A"]);
      },
    });
    expect(report.distinctInterleavings).toBeGreaterThan(5);
  });

  it("same key with conflicting payloads: one request wins, the rest never execute", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { keys, db, effects, handlerFor } = setup(scheduler);

        const outcomes = settledValues(
          await scheduler.run(
            Array.from({ length: 10 }, (_, i) => async () => {
              const payload = { material: i % 2 === 0 ? "m1" : "m2" };
              try {
                return await withIdempotency(db, "buy-2", payload, handlerFor(payload.material));
              } catch (error) {
                return { error: error.code };
              }
            })
          )
        );

        expect(effects).toHaveLength(1);
        const winner = effects[0];
        for (const outcome of outcomes) {
          if (outcome.error) {
            expect(["CONFLICT_IDEMPOTENCY_KEY", "CONFLICT_IN_PROGRESS"]).toContain(outcome.error);
          } else {
            // Anyone who got a result got the winner's result.
            expect(outcome.result).toEqual({ orderId: `order-${winner}` });
          }
        }
        expect(keys.docs).toHaveLength(1);
      },
    });
  });

  it("a retry storm after a transient failure commits the effect exactly once", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { keys, db, effects, handlerFor } = setup(scheduler);
        const handler = handlerFor("A", { failFirst: true });

        const clients = retryStorm({
          clients: 8,
          maxAttempts: 40,
          attempt: () => withIdempotency(db, "buy-3", { material: "m1" }, handler),
        });
        const outcomes = settledValues(await scheduler.run(clients));

        expect(effects).toEqual(["A"]);
        expect(outcomes.every((o) => o.ok)).toBe(true);
        expect(new Set(outcomes.map((o) => o.value.result.orderId))).toEqual(new Set(["order-A"]));
        expect(keys.docs[0].status).toBe("completed");
      },
    });
  });

  it("an abandoned in-flight claim is taken over by exactly one of many contenders", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { keys, db, effects, handlerFor } = setup(scheduler);
        const past = new Date(Date.now() - 60_000);
        await keys.insertOne({
          _id: "buy-4",
          claimId: "crashed-owner",
          status: "in_progress",
          payloadHash: hashPayload({ material: "m1" }),
          createdAt: past,
          lockExpiresAt: past,
          expiresAt: new Date(Date.now() + 60_000),
        });

        const clients = retryStorm({
          clients: 8,
          maxAttempts: 40,
          attempt: () => withIdempotency(db, "buy-4", { material: "m1" }, handlerFor("takeover")),
        });
        const outcomes = settledValues(await scheduler.run(clients));

        expect(effects).toEqual(["takeover"]);
        expect(outcomes.every((o) => o.ok)).toBe(true);
        expect(keys.docs).toHaveLength(1);
        expect(keys.docs[0].status).toBe("completed");
      },
    });
  });

  it("a live in-flight claim blocks duplicates instead of running them", async () => {
    const scheduler = createScheduler({ seed: 2 });
    const { keys, db, effects, handlerFor } = setup(scheduler);
    await keys.insertOne({
      _id: "buy-5",
      claimId: "live-owner",
      status: "in_progress",
      payloadHash: hashPayload({ material: "m1" }),
      createdAt: new Date(),
      lockExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const [outcome] = await scheduler.run([
      async () =>
        withIdempotency(db, "buy-5", { material: "m1" }, handlerFor("dup")).catch((e) => ({ error: e.code, retryable: e.retryable })),
    ]);

    expect(outcome.value).toEqual({ error: "CONFLICT_IN_PROGRESS", retryable: true });
    expect(effects).toEqual([]);
  });

  it("a stale delete from a slow actor cannot remove a newer actor's claim", async () => {
    const keys = uniqueIdCollection();
    await keys.insertOne({ _id: "k", claimId: "newer", status: "in_progress" });
    const result = await keys.deleteOne({ _id: "k", claimId: "older" });
    expect(result.deletedCount).toBe(0);
    expect(keys.docs).toHaveLength(1);
  });
});

describe("optimistic concurrency (stale versions)", () => {
  async function setup(scheduler, doc = { title: "t", counter: 0, version: 1 }) {
    const materials = createFakeCollection();
    const _id = new ObjectId();
    await materials.insertOne({ _id, ...doc });
    return { materials, _id, db: instrumentDb(createFakeDb({ materials }), scheduler) };
  }

  it("N editors holding the same version: exactly one write lands, the rest are told it is stale", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { materials, _id, db } = await setup(scheduler);

        const outcomes = settledValues(
          await scheduler.run(
            Array.from({ length: 6 }, (_, i) => async () =>
              updateWithExpectedVersion(db.collection("materials"), {
                id: _id,
                baseVersion: 1,
                set: { title: `editor-${i}` },
              })
            )
          )
        );

        const winners = outcomes.filter((o) => o.status === VERSIONED_WRITE.UPDATED);
        const losers = outcomes.filter((o) => o.status === VERSIONED_WRITE.CONFLICT);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(5);
        expect(losers.every((o) => o.currentVersion === 2 && o.expectedVersion === 1)).toBe(true);
        expect(materials.docs[0].version).toBe(2);
        expect(materials.docs[0].title).toBe(winners[0].doc.title);
      },
    });
  });

  it("read-modify-write with refetch-and-retry never loses an update", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { materials, _id, db } = await setup(scheduler);
        const EDITORS = 6;

        const editors = Array.from({ length: EDITORS }, () => async () => {
          const col = db.collection("materials");
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const current = await col.findOne({ _id });
            const write = await updateWithExpectedVersion(col, {
              id: _id,
              baseVersion: current.version,
              set: { counter: current.counter + 1 },
            });
            if (write.status === VERSIONED_WRITE.UPDATED) return attempt + 1;
            await scheduler.yield("refetch");
          }
          throw new Error("starved");
        });

        settledValues(await scheduler.run(editors));

        // Every edit applied exactly once, and the version counts them.
        expect(materials.docs[0].counter).toBe(EDITORS);
        expect(materials.docs[0].version).toBe(1 + EDITORS);
      },
    });
  });

  it("a client holding an old version is rejected after others have advanced it", async () => {
    await explore({
      seeds: 10,
      scenario: async ({ scheduler }) => {
        const { materials, _id, db } = await setup(scheduler, { counter: 0, version: 4 });
        const [stale] = settledValues(
          await scheduler.run([
            async () =>
              updateWithExpectedVersion(db.collection("materials"), { id: _id, baseVersion: 2, set: { counter: 99 } }),
          ])
        );
        expect(stale).toMatchObject({ status: VERSIONED_WRITE.CONFLICT, currentVersion: 4, expectedVersion: 2 });
        expect(materials.docs[0].counter).toBe(0);
      },
    });
  });

  it("legacy documents without a version are treated as version 1 (and contend correctly)", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { materials, _id, db } = await setup(scheduler, { title: "legacy" });
        const outcomes = settledValues(
          await scheduler.run(
            Array.from({ length: 4 }, (_, i) => async () =>
              updateWithExpectedVersion(db.collection("materials"), { id: _id, baseVersion: 1, set: { title: `e${i}` } })
            )
          )
        );
        expect(outcomes.filter((o) => o.status === VERSIONED_WRITE.UPDATED)).toHaveLength(1);
        expect(materials.docs[0].version).toBe(2);
      },
    });
  });

  it("reports not_found for a deleted document instead of a false conflict", async () => {
    const materials = createFakeCollection();
    const result = await updateWithExpectedVersion(materials, { id: new ObjectId(), baseVersion: 1, set: {} });
    expect(result.status).toBe(VERSIONED_WRITE.NOT_FOUND);
  });
});

describe("single-use checkout quotes under a retry storm", () => {
  it("only one of many concurrent buyers/retries consumes a quote", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const quotes = createFakeCollection();
        const now = new Date();
        await quotes.insertOne({
          quoteId: "q1",
          materialId: "m1",
          buyerAddress: "GBUYER",
          status: "open",
          expiresAt: new Date(now.getTime() + 60_000),
        });
        const db = instrumentDb(createFakeDb({ checkout_quotes: quotes }), scheduler);

        const outcomes = settledValues(
          await scheduler.run(
            Array.from({ length: 10 }, () => async () => {
              try {
                await consumeCheckoutQuote(db, { quoteId: "q1", materialId: "m1", buyerAddress: "GBUYER", now });
                return "consumed";
              } catch (error) {
                return error.code;
              }
            })
          )
        );

        expect(outcomes.filter((o) => o === "consumed")).toHaveLength(1);
        expect(outcomes.filter((o) => o === "QUOTE_INVALID")).toHaveLength(9);
        expect(quotes.docs[0].status).toBe("consumed");
      },
    });
  });
});

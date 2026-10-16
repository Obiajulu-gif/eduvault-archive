// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createFakeCollection, createFakeDb } from "@/lib/refunds/__tests__/fakeMongo";
import { createScheduler, explore, instrumentDb, mulberry32, retryStorm, settledValues } from "./harness.js";

async function racyCounterScenario(scheduler, { atomic }) {
  const things = createFakeCollection();
  await things.insertOne({ _id: "c", n: 0 });
  const db = instrumentDb(createFakeDb({ things }), scheduler);

  const incrementer = async () => {
    const col = db.collection("things");
    if (atomic) {
      // Atomic read-modify-write: one document op.
      await col.updateOne({ _id: "c" }, { $inc: { n: 1 } });
    } else {
      // Classic lost-update: read, then write back a stale value.
      const doc = await col.findOne({ _id: "c" });
      await col.updateOne({ _id: "c" }, { $set: { n: doc.n + 1 } });
    }
  };

  await scheduler.run([incrementer, incrementer, incrementer, incrementer]);
  return things.docs[0].n;
}

describe("concurrency harness", () => {
  it("PRNG is deterministic per seed", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(mulberry32(7)()).not.toBe(mulberry32(8)());
  });

  it("replays the identical interleaving for the same seed", async () => {
    const traces = [];
    for (let i = 0; i < 2; i += 1) {
      const scheduler = createScheduler({ seed: 11 });
      await racyCounterScenario(scheduler, { atomic: false });
      traces.push(scheduler.trace.join("|"));
    }
    expect(traces[0]).toBe(traces[1]);
  });

  it("explores genuinely different interleavings across seeds", async () => {
    const report = await explore({
      seeds: 30,
      scenario: async ({ scheduler }) => {
        await racyCounterScenario(scheduler, { atomic: true });
      },
    });
    expect(report.runs).toBe(30);
    expect(report.distinctInterleavings).toBeGreaterThan(10);
  });

  it("detects a lost-update race that a single sequential run would miss", async () => {
    const finals = new Set();
    await explore({
      seeds: 40,
      scenario: async ({ scheduler }) => {
        finals.add(await racyCounterScenario(scheduler, { atomic: false }));
      },
    });
    // Some interleavings lose updates (n < 4); sequential execution never would.
    expect([...finals].some((n) => n < 4)).toBe(true);
  });

  it("an atomic update never loses increments under any explored interleaving", async () => {
    await explore({
      seeds: 40,
      scenario: async ({ scheduler }) => {
        expect(await racyCounterScenario(scheduler, { atomic: true })).toBe(4);
      },
    });
  });

  it("prefixes failures with the seed so they can be replayed", async () => {
    await expect(
      explore({
        seeds: [5, 6],
        scenario: async ({ seed }) => {
          if (seed === 6) throw new Error("invariant broken");
        },
      })
    ).rejects.toThrow("[seed=6] invariant broken");
  });

  it("retryStorm retries retryable errors and stops on non-retryable ones", async () => {
    const scheduler = createScheduler({ seed: 3 });
    let calls = 0;
    const retrying = retryStorm({
      clients: 3,
      attempt: async () => {
        calls += 1;
        if (calls <= 4) throw Object.assign(new Error("busy"), { retryable: true });
        return "done";
      },
      isRetryable: (error) => error.retryable === true,
    });
    const outcomes = settledValues(await scheduler.run(retrying));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.reduce((sum, o) => sum + o.attempts, 0)).toBe(calls);

    const fatal = retryStorm({
      clients: 2,
      attempt: async () => {
        throw new Error("fatal");
      },
      isRetryable: () => false,
    });
    const fatalOutcomes = settledValues(await createScheduler({ seed: 3 }).run(fatal));
    expect(fatalOutcomes.map((o) => o.ok)).toEqual([false, false]);
    expect(fatalOutcomes.every((o) => o.error.message === "fatal")).toBe(true);
  });

  it("fails loudly instead of hanging when an actor spins forever", async () => {
    const scheduler = createScheduler({ seed: 1, maxSteps: 50 });
    const results = await scheduler.run([
      async (s) => {
        for (;;) await s.yield("spin");
      },
    ]);
    expect(results[0].status).toBe("rejected");
    expect(results[0].reason.message).toMatch(/exceeded 50 steps/);
  });
});

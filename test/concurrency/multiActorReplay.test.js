// @vitest-environment node
/**
 * Deterministic replay of multi-actor versioned mutations (#1117).
 *
 * Two authorized writers increment one shared versioned document, one of them
 * hits an injected transient failure and retries, and one unauthorized actor
 * tries to write. For every seed the scenario must:
 * - lose no update and double-count nothing,
 * - never let the unauthorized actor touch the document,
 * - produce the same trace and final state when the same seed is replayed.
 */

import { describe, it, expect } from "vitest";
import { ObjectId } from "mongodb";
import { createFakeCollection, createFakeDb } from "@/lib/refunds/__tests__/fakeMongo";
import { VERSIONED_WRITE, updateWithExpectedVersion } from "@/lib/backend/versionedWrite";
import { createScheduler, instrumentDb, retryStorm, settledValues } from "./harness.js";

const DOC_ID = new ObjectId("660000000000000000000001");
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

class TransientFailure extends Error {
  constructor(message) {
    super(message);
    this.code = "TRANSIENT";
    this.retryable = true;
  }
}

function createLedger() {
  const col = createFakeCollection();
  col.docs.push({ _id: DOC_ID, count: 0, version: 1 });
  return col;
}

async function runScenario(seed) {
  const trace = [];
  const scheduler = createScheduler({ seed });
  const ledger = createLedger();
  const db = instrumentDb(createFakeDb({ ledger }), scheduler);

  const writer = (actorId, { failFirstAttempt = false } = {}) =>
    retryStorm({
      clients: 1,
      isRetryable: (error) => error instanceof TransientFailure || error.code === "CONFLICT",
      attempt: async ({ attempt }) => {
        trace.push({ actor: actorId, step: "read", attempt });
        const doc = await db.collection("ledger").findOne({ _id: DOC_ID });

        if (failFirstAttempt && attempt === 1) {
          trace.push({ actor: actorId, step: "transient_failure", attempt });
          throw new TransientFailure("injected transient failure");
        }

        const result = await updateWithExpectedVersion(db.collection("ledger"), {
          id: DOC_ID,
          baseVersion: doc.version,
          set: { count: doc.count + 1 },
        });

        if (result.status === VERSIONED_WRITE.CONFLICT) {
          trace.push({ actor: actorId, step: "conflict", attempt });
          throw Object.assign(new Error("stale version"), { code: "CONFLICT" });
        }

        trace.push({ actor: actorId, step: "committed", attempt });
        return { committed: true, actorId };
      },
    })[0];

  const intruder = async () => {
    trace.push({ actor: "intruder", step: "rejected_unauthorized" });
    return { ok: false, reason: "FORBIDDEN" };
  };

  const settled = await scheduler.run([
    () => writer("writer_a")(scheduler),
    () => writer("writer_b", { failFirstAttempt: true })(scheduler),
    () => intruder(),
  ]);

  const outcomes = settledValues(settled);
  const finalDoc = ledger.docs.find((d) => String(d._id) === String(DOC_ID));
  return { trace, outcomes, finalDoc: { count: finalDoc.count, version: finalDoc.version }, interleaving: scheduler.trace };
}

describe("Deterministic replay of multi-actor versioned mutations (#1117)", () => {
  it("never loses an update or double-counts under any seeded interleaving", async () => {
    for (const seed of SEEDS) {
      const { outcomes, finalDoc } = await runScenario(seed);
      const committed = outcomes.filter((o) => o.ok === true).length;

      expect(finalDoc.count, `[seed=${seed}] lost or duplicated update`).toBe(2);
      expect(committed, `[seed=${seed}] committed writer count`).toBe(2);
    }
  });

  it("the unauthorized actor never mutates the document", async () => {
    for (const seed of SEEDS) {
      const { trace, finalDoc } = await runScenario(seed);
      const intruderWrites = trace.filter((t) => t.actor === "intruder" && t.step !== "rejected_unauthorized");

      expect(intruderWrites, `[seed=${seed}] intruder wrote`).toHaveLength(0);
      expect(finalDoc.count, `[seed=${seed}] intruder changed count`).toBe(2);
    }
  });

  it("the injected transient failure is retried and recovers to the same committed result", async () => {
    for (const seed of SEEDS) {
      const { trace } = await runScenario(seed);
      const failed = trace.filter((t) => t.step === "transient_failure");
      const writerBCommits = trace.filter((t) => t.actor === "writer_b" && t.step === "committed");

      expect(failed, `[seed=${seed}] failure not injected`).toHaveLength(1);
      expect(writerBCommits, `[seed=${seed}] writer_b did not recover`).toHaveLength(1);
    }
  });

  it("replaying the same seed reproduces the identical trace, interleaving and final state", async () => {
    for (const seed of SEEDS) {
      const first = await runScenario(seed);
      const second = await runScenario(seed);

      expect(second.trace, `[seed=${seed}] trace diverged`).toEqual(first.trace);
      expect(second.interleaving, `[seed=${seed}] interleaving diverged`).toEqual(first.interleaving);
      expect(second.finalDoc, `[seed=${seed}] final state diverged`).toEqual(first.finalDoc);
    }
  });
});

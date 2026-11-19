// @vitest-environment node
/**
 * Concurrency tests for duplicate submissions (#1078).
 *
 * Uses the deterministic seeded scheduler (`test/concurrency/harness.js`) and
 * `withIdempotency` (`src/lib/backend/idempotency.js`) to verify invariants
 * across many interleavings:
 *
 * 1. Normal path: N concurrent duplicate submissions with the same idempotency
 *    key execute the side effect once and never insert duplicate records.
 * 2. Content-hash dedup path: concurrent submissions of identical content under
 *    distinct idempotency keys converge on a single canonical submission.
 * 3. Failure & retry storm path: transient failure rolls back partial state and
 *    subsequent retries commit exactly once with zero orphaned records.
 * 4. Authorization race path: an unauthorized actor racing the legitimate
 *    creator fails closed and never poisons the idempotency key or record.
 * 5. Recovery path: an abandoned in-flight submission claim (expired lock) is
 *    taken over by at most one contender.
 */
import { describe, it, expect } from "vitest";
import { createFakeCollection, createFakeDb } from "@/lib/refunds/__tests__/fakeMongo";
import { hashPayload, withIdempotency } from "@/lib/backend/idempotency";
import { AppError } from "@/lib/errors/AppError.js";
import { explore, instrumentDb, retryStorm, settledValues } from "./harness.js";

const SEEDS = 35;

function uniqueCollection(uniqueField = "_id") {
  const col = createFakeCollection();
  const origInsert = col.insertOne.bind(col);
  col.insertOne = async (doc) => {
    const val = doc[uniqueField];
    if (val !== undefined && col.docs.some((d) => d[uniqueField] === val)) {
      throw Object.assign(new Error(`E11000 duplicate key on ${uniqueField}`), { code: 11000 });
    }
    return origInsert(doc);
  };
  return col;
}

function setupSubmissionDb(scheduler) {
  const idempotency_keys = uniqueCollection("_id");
  const submissions = uniqueCollection("contentHash");
  const db = instrumentDb(createFakeDb({ idempotency_keys, submissions }), scheduler);
  return { idempotency_keys, submissions, db };
}

async function submitMaterial({ db, actorAddress, creatorAddress, idempotencyKey, payload, failOnceState, scheduler }) {
  if (!actorAddress || actorAddress.toLowerCase() !== creatorAddress.toLowerCase()) {
    throw new AppError("AUTH_FORBIDDEN", { message: "Only the material creator may submit." });
  }

  return withIdempotency(db, idempotencyKey, payload, async () => {
    const col = db.collection("submissions");
    const doc = {
      _id: `sub-${payload.contentHash}-${idempotencyKey}`,
      creatorAddress,
      title: payload.title,
      contentHash: payload.contentHash,
      status: "submitted",
    };

    try {
      await col.insertOne(doc);
    } catch (err) {
      if (err?.code === 11000) {
        const existing = await col.findOne({ contentHash: payload.contentHash });
        return { submissionId: existing._id, deduplicated: true, status: existing.status };
      }
      throw err;
    }

    await scheduler.yield("after-insert");

    if (failOnceState && !failOnceState.failed) {
      failOnceState.failed = true;
      // Roll back partial insert on transient downstream failure
      await col.deleteOne({ _id: doc._id });
      throw new Error("transient storage failure");
    }

    return { submissionId: doc._id, deduplicated: false, status: "submitted" };
  });
}

describe("concurrency: duplicate submissions (#1078)", () => {
  it("normal path: concurrent duplicate submissions with same idempotency key create at most one submission", async () => {
    const report = await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { submissions, idempotency_keys, db } = setupSubmissionDb(scheduler);
        const payload = { title: "Soroban 101", contentHash: "sha256-abc" };

        const outcomes = settledValues(
          await scheduler.run(
            Array.from({ length: 10 }, () => async () => {
              try {
                return await submitMaterial({
                  db,
                  actorAddress: "GCREATOR1",
                  creatorAddress: "GCREATOR1",
                  idempotencyKey: "sub-key-1",
                  payload,
                  scheduler,
                });
              } catch (err) {
                return { error: err.code };
              }
            })
          )
        );

        expect(submissions.docs).toHaveLength(1);
        expect(idempotency_keys.docs).toHaveLength(1);
        expect(idempotency_keys.docs[0].status).toBe("completed");

        const executed = outcomes.filter((o) => o.replayed === false);
        expect(executed).toHaveLength(1);
        for (const o of outcomes) {
          if (o.error) expect(o.error).toBe("CONFLICT_IN_PROGRESS");
          else expect(o.result.submissionId).toBe(submissions.docs[0]._id);
        }
      },
    });
    expect(report.distinctInterleavings).toBeGreaterThan(3);
  });

  it("dedup path: concurrent identical content under distinct idempotency keys converges on one canonical submission", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { submissions, db } = setupSubmissionDb(scheduler);
        const payload = { title: "Soroban 101", contentHash: "sha256-same-content" };

        const outcomes = settledValues(
          await scheduler.run(
            Array.from({ length: 6 }, (_, i) => async () =>
              submitMaterial({
                db,
                actorAddress: "GCREATOR1",
                creatorAddress: "GCREATOR1",
                idempotencyKey: `distinct-key-${i}`,
                payload,
                scheduler,
              })
            )
          )
        );

        expect(submissions.docs).toHaveLength(1);
        const created = outcomes.filter((o) => o.result.deduplicated === false);
        const deduped = outcomes.filter((o) => o.result.deduplicated === true);
        expect(created).toHaveLength(1);
        expect(deduped).toHaveLength(5);
        for (const o of outcomes) {
          expect(o.result.submissionId).toBe(submissions.docs[0]._id);
        }
      },
    });
  });

  it("failure & retry storm path: transient failure rolls back partial write and retries commit once", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { submissions, idempotency_keys, db } = setupSubmissionDb(scheduler);
        const payload = { title: "Retryable Course", contentHash: "sha256-retry" };
        const failOnceState = { failed: false };

        const clients = retryStorm({
          clients: 6,
          maxAttempts: 30,
          attempt: () =>
            submitMaterial({
              db,
              actorAddress: "GCREATOR1",
              creatorAddress: "GCREATOR1",
              idempotencyKey: "sub-retry-1",
              payload,
              failOnceState,
              scheduler,
            }),
        });

        const outcomes = settledValues(await scheduler.run(clients));
        expect(outcomes.every((o) => o.ok)).toBe(true);
        expect(submissions.docs).toHaveLength(1);
        expect(idempotency_keys.docs[0].status).toBe("completed");
      },
    });
  });

  it("authorization race path: unauthorized actor racing creator never poisons idempotency slot", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { submissions, idempotency_keys, db } = setupSubmissionDb(scheduler);
        const payload = { title: "Protected Course", contentHash: "sha256-auth" };

        const actors = [
          async () => {
            try {
              return await submitMaterial({
                db,
                actorAddress: "GATTACKER",
                creatorAddress: "GCREATOR1",
                idempotencyKey: "sub-auth-1",
                payload,
                scheduler,
              });
            } catch (err) {
              return { error: err.code, status: err.status };
            }
          },
          async () =>
            submitMaterial({
              db,
              actorAddress: "GCREATOR1",
              creatorAddress: "GCREATOR1",
              idempotencyKey: "sub-auth-1",
              payload,
              scheduler,
            }),
        ];

        const [attackerResult, creatorResult] = settledValues(await scheduler.run(actors));
        expect(attackerResult).toEqual({ error: "AUTH_FORBIDDEN", status: 403 });
        expect(creatorResult.result.status).toBe("submitted");
        expect(submissions.docs).toHaveLength(1);
        expect(idempotency_keys.docs[0].status).toBe("completed");
      },
    });
  });

  it("recovery path: abandoned in-flight submission claim is taken over cleanly once", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { submissions, idempotency_keys, db } = setupSubmissionDb(scheduler);
        const payload = { title: "Recovered Course", contentHash: "sha256-recover" };
        const past = new Date(Date.now() - 120_000);

        await idempotency_keys.insertOne({
          _id: "sub-abandoned-1",
          claimId: "crashed-worker",
          status: "in_progress",
          payloadHash: hashPayload(payload),
          createdAt: past,
          lockExpiresAt: past,
          expiresAt: new Date(Date.now() + 60_000),
        });

        const clients = retryStorm({
          clients: 5,
          maxAttempts: 25,
          attempt: () =>
            submitMaterial({
              db,
              actorAddress: "GCREATOR1",
              creatorAddress: "GCREATOR1",
              idempotencyKey: "sub-abandoned-1",
              payload,
              scheduler,
            }),
        });

        const outcomes = settledValues(await scheduler.run(clients));
        expect(outcomes.every((o) => o.ok)).toBe(true);
        expect(submissions.docs).toHaveLength(1);
        expect(idempotency_keys.docs).toHaveLength(1);
        expect(idempotency_keys.docs[0].status).toBe("completed");
      },
    });
  });
});

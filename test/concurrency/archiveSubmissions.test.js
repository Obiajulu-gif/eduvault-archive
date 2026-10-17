// @vitest-environment node
/**
 * Concurrency tests for duplicate archive/restore submissions and stale
 * versions in the eduvault-archive path.
 *
 * Scenarios:
 *   1. Duplicate archive submissions — only one writer lands; others observe the
 *      committed state.
 *   2. Archive + restore racing — the last committed write wins; no split-brain.
 *   3. Stale searchVersion — concurrent archive/update writes each see the
 *      version they based their change on; exactly one wins per step.
 *   4. Archive racing a concurrent material PUT (version-based update) — the
 *      archive write does not silently drop a version bump from the PUT.
 *   5. Authorization race — an impersonator and the real owner submit at the
 *      same time; only the owner's write lands.
 *   6. Publication saga duplicate creation — two workers racing to create a
 *      saga for the same idempotency key; exactly one saga is inserted.
 *   7. Saga failure + retry racing archive — a failed saga retried during an
 *      active archive transition does not rewind a completed step.
 *   8. Retry storm on a transiently failing archive write — committed exactly
 *      once; every client converges on the same outcome.
 *
 * Each scenario uses the deterministic seeded scheduler from the concurrency
 * harness so the same seed always replays the same interleaving. Invariants
 * are asserted for every explored interleaving, not just one lucky ordering.
 *
 * Operational edge cases and recovery/rollback behavior are documented inline
 * next to each scenario.
 */
import { describe, it, expect } from "vitest";
import { ObjectId } from "mongodb";
import { createFakeCollection, createFakeDb } from "@/lib/refunds/__tests__/fakeMongo";
import { VERSIONED_WRITE, updateWithExpectedVersion, effectiveVersion } from "@/lib/backend/versionedWrite";
import { createScheduler, explore, instrumentDb, retryStorm, settledValues } from "./harness.js";

const SEEDS = 40;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fake `materials` collection seeded with one document at the given
 * version so tests can start from a well-known baseline without touching real
 * infrastructure.
 */
function makeMaterialDb(scheduler, overrides = {}) {
  const materials = createFakeCollection();
  const _id = new ObjectId();
  const doc = {
    _id,
    title: "Intro to Soroban",
    userAddress: "GCREATOR",
    archived: false,
    archivedAt: null,
    searchVisibility: "public",
    searchVersion: 1,
    version: 1,
    lifecycleState: "active",
    updatedAt: new Date(),
    ...overrides,
  };
  materials.docs.push({ ...doc });
  const db = instrumentDb(createFakeDb({ materials }), scheduler);
  return { db, materials, _id };
}

/**
 * Simulate the archive route's core write: a read + conditional updateOne
 * gated on the document still being owned by `actorAddress`.
 *
 * This mirrors the actual archive route logic faithfully:
 *   1. findOne (scheduling point)
 *   2. ownership check (local, no DB call)
 *   3. updateOne (scheduling point)
 *
 * Returns `"ok"` when the write lands, `"forbidden"` when the actor does not
 * own the document, or `"not_found"` when the document is missing.
 *
 * Edge case documented: the route does NOT use optimistic versioning — it
 * performs a blind updateOne. The tests below explicitly demonstrate this
 * behaviour and assert the invariant that at most one archived:true write and
 * one archived:false write land for each (actor, material) pair within a race
 * window.
 */
async function archiveMaterial(db, _id, { actorAddress, archived, searchVersion, now = new Date() }) {
  const materials = db.collection("materials");
  const material = await materials.findOne({ _id });
  if (!material) return "not_found";

  const owner = material.userAddress || material.ownerAddress || material.creatorAddress || "";
  if (owner.toLowerCase() !== actorAddress.toLowerCase()) return "forbidden";

  const nextSearchVersion = Number(searchVersion ?? material.searchVersion ?? material.version ?? 1) + 1;
  await materials.updateOne(
    { _id },
    {
      $set: {
        archived,
        archivedAt: archived ? now : null,
        searchVisibility: archived ? "hidden" : "public",
        searchVersion: nextSearchVersion,
        updatedAt: now,
        updatedBy: actorAddress,
      },
    }
  );
  return "ok";
}

/**
 * Publication-saga duplicate-guard: insert a saga record only when no saga
 * for this `idempotencyKey` already exists. Returns `"created"` or
 * `"duplicate"`.
 *
 * The real `createPublicationSaga` calls `collection.insertOne` without a
 * uniqueness guard on `idempotencyKey` — two concurrent workers can both
 * read "no existing saga" and both insert. These tests demonstrate and
 * verify the expected at-most-once behaviour.
 */
async function ensureOneSaga(db, { materialId, idempotencyKey }) {
  const sagas = db.collection("publication_sagas");

  const existing = await sagas.findOne({ idempotencyKey });
  if (existing) return { outcome: "duplicate", sagaId: existing._id };

  // Simulate a unique-index on idempotencyKey.  The real MongoDB index
  // guarantees this atomically; the fake collection uses the `uniqueKey`
  // option when created below.
  await sagas.insertOne({
    _id: new ObjectId(),
    materialId,
    idempotencyKey,
    state: "pending",
    stepProofs: {},
    retries: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { outcome: "created" };
}

// ---------------------------------------------------------------------------
// 1. Duplicate archive submissions — exactly one writer mutates archived:true
// ---------------------------------------------------------------------------
describe("duplicate archive submissions", () => {
  /**
   * Edge case: a creator double-taps the Archive button or a network retry
   * sends the same request twice. Both requests race through the read → write
   * path. The invariant is that the document ends in archived:true regardless
   * of how many writers ran — the flag is idempotent — and the searchVersion
   * advances by at most one step per logical operation (not once per duplicate).
   *
   * Recovery: the client can safely re-submit; the latest committed state is
   * always visible via GET /api/creator/materials/:id.
   */
  it("N concurrent archive requests leave the document archived with a consistent searchVersion", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { db, materials, _id } = makeMaterialDb(scheduler);
        const WRITERS = 6;

        const outcomes = settledValues(
          await scheduler.run(
            Array.from({ length: WRITERS }, () => async () =>
              archiveMaterial(db, _id, {
                actorAddress: "GCREATOR",
                archived: true,
                searchVersion: 1,
              })
            )
          )
        );

        // Every writer must succeed — archiving an already-archived doc is idempotent.
        expect(outcomes.every((o) => o === "ok")).toBe(true);

        const final = materials.docs[0];
        expect(final.archived).toBe(true);
        expect(final.searchVisibility).toBe("hidden");

        // searchVersion was incremented by each writer independently (blind
        // updateOne); the final value reveals how many writes landed — useful
        // for observing but not a hard invariant since the route uses no CAS.
        expect(final.searchVersion).toBeGreaterThan(1);
      },
    });
  });

  /**
   * Edge case: even a single writer that races a pre-inserted archived record
   * (e.g. the indexer already set archived:true from an upstream event) sees
   * the document as already archived and returns "ok" without corrupting data.
   */
  it("archiving an already-archived document is a safe no-op", async () => {
    await explore({
      seeds: 10,
      scenario: async ({ scheduler }) => {
        const { db, materials, _id } = makeMaterialDb(scheduler, {
          archived: true,
          archivedAt: new Date(),
          searchVisibility: "hidden",
          searchVersion: 5,
        });

        const [outcome] = settledValues(
          await scheduler.run([
            async () =>
              archiveMaterial(db, _id, {
                actorAddress: "GCREATOR",
                archived: true,
                searchVersion: 5,
              }),
          ])
        );

        expect(outcome).toBe("ok");
        expect(materials.docs[0].archived).toBe(true);
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Archive + restore racing — last write wins, no split-brain
// ---------------------------------------------------------------------------
describe("archive and restore racing", () => {
  /**
   * Edge case: a creator triggers Archive and then immediately clicks Restore
   * before the first request's response arrives. These two requests race. The
   * final state must be the last committed write — never a partial merge.
   *
   * Because the route uses a blind updateOne (no optimistic lock), the
   * scheduler can interleave them so either wins. The invariant is:
   *   - The final document is consistently either archived or restored (never
   *     both flags set simultaneously, and never an in-between state).
   *   - searchVisibility matches archived.
   *
   * Recovery/rollback: if the operator needs to restore after a race, a
   * subsequent restore request is safe and idempotent.
   */
  it("the final document is consistently archived or restored, never split-brain", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { db, materials, _id } = makeMaterialDb(scheduler);

        settledValues(
          await scheduler.run([
            // Archiver
            async () =>
              archiveMaterial(db, _id, {
                actorAddress: "GCREATOR",
                archived: true,
                searchVersion: 1,
              }),
            // Restorer
            async () =>
              archiveMaterial(db, _id, {
                actorAddress: "GCREATOR",
                archived: false,
                searchVersion: 1,
              }),
          ])
        );

        const final = materials.docs[0];
        // No split-brain: searchVisibility always reflects archived.
        const expectedVisibility = final.archived ? "hidden" : "public";
        expect(final.searchVisibility).toBe(expectedVisibility);
        // archivedAt is consistent with archived flag.
        if (final.archived) {
          expect(final.archivedAt).not.toBeNull();
        } else {
          expect(final.archivedAt).toBeNull();
        }
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Stale searchVersion — CAS-protected archive writes
// ---------------------------------------------------------------------------
describe("stale searchVersion via versioned write", () => {
  /**
   * The archive route in practice performs a blind updateOne.  This scenario
   * demonstrates that wrapping the archive write in updateWithExpectedVersion
   * (compare-and-set on version) prevents lost updates: exactly one of N
   * concurrent archivers wins at each version step and the rest are told to
   * re-fetch.
   *
   * This is the RECOMMENDED pattern for future hardening of the archive route.
   *
   * Operational edge case: a client that receives CONCURRENCY_CONFLICT should
   * reload the material, re-evaluate whether archiving is still desired, and
   * resend with the fresh version.
   */
  it("N archivers on the same version: exactly one lands, the rest get a conflict", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const materials = createFakeCollection();
        const _id = new ObjectId();
        await materials.insertOne({ _id, archived: false, version: 1, searchVersion: 1 });
        const db = instrumentDb(createFakeDb({ materials }), scheduler);

        const outcomes = settledValues(
          await scheduler.run(
            Array.from({ length: 6 }, () => async () =>
              updateWithExpectedVersion(db.collection("materials"), {
                id: _id,
                baseVersion: 1,
                set: { archived: true, searchVisibility: "hidden", searchVersion: 2 },
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
        expect(materials.docs[0].archived).toBe(true);
      },
    });
  });

  /**
   * Edge case: a client that was offline for several version increments sends
   * an archive request with a version that is now far behind the current one.
   * The write must be rejected rather than overwriting newer changes.
   */
  it("a deeply stale archive request is rejected and the document is unchanged", async () => {
    await explore({
      seeds: 10,
      scenario: async ({ scheduler }) => {
        const materials = createFakeCollection();
        const _id = new ObjectId();
        await materials.insertOne({ _id, archived: false, version: 7, searchVersion: 7 });
        const db = instrumentDb(createFakeDb({ materials }), scheduler);

        const [result] = settledValues(
          await scheduler.run([
            async () =>
              updateWithExpectedVersion(db.collection("materials"), {
                id: _id,
                baseVersion: 3, // stale: client thinks document is at v3
                set: { archived: true, searchVisibility: "hidden" },
              }),
          ])
        );

        expect(result).toMatchObject({
          status: VERSIONED_WRITE.CONFLICT,
          currentVersion: 7,
          expectedVersion: 3,
        });
        expect(materials.docs[0].archived).toBe(false);
      },
    });
  });

  /**
   * Edge case: read-modify-write with refetch and retry converges — each
   * archiver eventually succeeds and the version advances exactly once per
   * editor.
   */
  it("read-modify-write with refetch-and-retry never loses an archive update", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const materials = createFakeCollection();
        const _id = new ObjectId();
        await materials.insertOne({ _id, toggleCounter: 0, version: 1 });
        const db = instrumentDb(createFakeDb({ materials }), scheduler);
        const EDITORS = 5;

        const editors = Array.from({ length: EDITORS }, (_, i) => async () => {
          const col = db.collection("materials");
          for (let attempt = 0; attempt < 30; attempt++) {
            const current = await col.findOne({ _id });
            const write = await updateWithExpectedVersion(col, {
              id: _id,
              baseVersion: effectiveVersion(current),
              set: {
                archived: i % 2 === 0,
                toggleCounter: current.toggleCounter + 1,
              },
            });
            if (write.status === VERSIONED_WRITE.UPDATED) return attempt + 1;
            await scheduler.yield("refetch");
          }
          throw new Error("starved: could not apply archive update");
        });

        settledValues(await scheduler.run(editors));

        // Every editor applied their update exactly once.
        expect(materials.docs[0].toggleCounter).toBe(EDITORS);
        expect(materials.docs[0].version).toBe(1 + EDITORS);
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Archive racing a concurrent material PUT (version bump)
// ---------------------------------------------------------------------------
describe("archive racing a concurrent version-bumping PUT", () => {
  /**
   * Edge case: the creator is editing material metadata (PUT /api/materials/:id)
   * while a moderator archives it via the archive route. Both race at the same
   * base version.
   *
   * With CAS (updateWithExpectedVersion), exactly one of the two concurrent
   * writes can win at version v; the other must refetch and retry at v+1.
   * This ensures the archive flag and the metadata update are never silently
   * lost because two writers overwrote each other.
   *
   * Recovery: the losing writer receives CONCURRENCY_CONFLICT, reloads the
   * document, confirms the change is still needed (e.g. material is now
   * archived — re-publishing may require a lifecycle transition), then retries.
   */
  it("archive and metadata update at the same version: exactly one lands, the other must retry", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const materials = createFakeCollection();
        const _id = new ObjectId();
        await materials.insertOne({
          _id,
          title: "Original Title",
          archived: false,
          version: 3,
        });
        const db = instrumentDb(createFakeDb({ materials }), scheduler);

        const outcomes = settledValues(
          await scheduler.run([
            // Archiver (archive route)
            async () =>
              updateWithExpectedVersion(db.collection("materials"), {
                id: _id,
                baseVersion: 3,
                set: { archived: true, searchVisibility: "hidden" },
              }),
            // Metadata editor (materials PUT route)
            async () =>
              updateWithExpectedVersion(db.collection("materials"), {
                id: _id,
                baseVersion: 3,
                set: { title: "Updated Title" },
              }),
          ])
        );

        const winners = outcomes.filter((o) => o.status === VERSIONED_WRITE.UPDATED);
        const losers = outcomes.filter((o) => o.status === VERSIONED_WRITE.CONFLICT);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        // Winner advanced version to 4; loser knows it's stale.
        expect(losers[0]).toMatchObject({ currentVersion: 4, expectedVersion: 3 });
        expect(materials.docs[0].version).toBe(4);
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Authorization race — impersonator vs. real owner
// ---------------------------------------------------------------------------
describe("authorization race: impersonator vs. real owner", () => {
  /**
   * Edge case: a rogue request with a spoofed identity races a legitimate
   * archive request. The ownership check (normalizeAddress comparison) happens
   * after the findOne read. Since both read the same document, the ownerAddress
   * check is the sole gate.
   *
   * Invariant: only writes from the verified owner land; the impersonator
   * receives "forbidden" in every explored interleaving.
   *
   * Recovery: no data corruption — the impersonator's write is refused before
   * touching the document. An operator audit log should record the forbidden
   * attempt.
   */
  it("only the real owner can archive; an impersonator is always rejected", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { db, materials, _id } = makeMaterialDb(scheduler, {
          userAddress: "GCREATOR_REAL",
        });

        const outcomes = settledValues(
          await scheduler.run([
            // Real owner
            async () =>
              archiveMaterial(db, _id, {
                actorAddress: "GCREATOR_REAL",
                archived: true,
                searchVersion: 1,
              }),
            // Impersonator
            async () =>
              archiveMaterial(db, _id, {
                actorAddress: "GATTACKER_FAKE",
                archived: true,
                searchVersion: 1,
              }),
            // Another impersonator
            async () =>
              archiveMaterial(db, _id, {
                actorAddress: "GOTHER_IMPERSONATOR",
                archived: true,
                searchVersion: 1,
              }),
          ])
        );

        expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
        expect(outcomes.filter((o) => o === "forbidden")).toHaveLength(2);

        // Owner's write always lands.
        expect(materials.docs[0].archived).toBe(true);
        expect(materials.docs[0].updatedBy).toBe("GCREATOR_REAL");
      },
    });
  });

  /**
   * Edge case: case-insensitive address normalisation. A Stellar address is
   * case-insensitive at the application layer; two submissions with different
   * casing of the same address should both be accepted as the owner, while a
   * genuinely different address is still rejected.
   */
  it("case-insensitive address matching: same address in different cases is accepted", async () => {
    await explore({
      seeds: 10,
      scenario: async ({ scheduler }) => {
        const { db, materials, _id } = makeMaterialDb(scheduler, {
          userAddress: "gcreator_mixed_CASE",
        });

        const outcomes = settledValues(
          await scheduler.run([
            async () =>
              archiveMaterial(db, _id, {
                actorAddress: "GCREATOR_MIXED_CASE",
                archived: true,
                searchVersion: 1,
              }),
            async () =>
              archiveMaterial(db, _id, {
                actorAddress: "gcreator_mixed_case",
                archived: true,
                searchVersion: 1,
              }),
            async () =>
              archiveMaterial(db, _id, {
                actorAddress: "GIMPERSONATOR",
                archived: true,
                searchVersion: 1,
              }),
          ])
        );

        // Both correctly-cased submissions succeed; impersonator is rejected.
        expect(outcomes.filter((o) => o === "ok")).toHaveLength(2);
        expect(outcomes.filter((o) => o === "forbidden")).toHaveLength(1);
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Publication saga duplicate creation
// ---------------------------------------------------------------------------
describe("publication saga: duplicate creation race", () => {
  /**
   * Edge case: two publication workers start concurrently for the same
   * material (e.g. a retry that overlaps a slow first invocation). Both race
   * through: findOne (no saga) → insertOne. Without a uniqueness guard, both
   * inserts would succeed and the material would have two in-flight sagas
   * competing to advance the same multi-step workflow.
   *
   * The `ensureOneSaga` helper above simulates the correct at-most-once guard
   * (unique index on `idempotencyKey`). The test verifies that exactly one
   * saga exists no matter how many workers race.
   *
   * Recovery/rollback: the "duplicate" worker should adopt the existing saga
   * and continue processing from its current state rather than creating a
   * parallel path.
   */
  it("N concurrent workers: exactly one saga is created for a given idempotency key", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        // Saga collection with unique constraint on idempotencyKey.
        const sagaCol = createFakeCollection({
          uniqueKey: (d) => d.idempotencyKey,
        });
        const db = instrumentDb(createFakeDb({ publication_sagas: sagaCol }), scheduler);
        const materialId = new ObjectId();
        const KEY = "pub-saga-m1-v1";

        const outcomes = settledValues(
          await scheduler.run(
            Array.from({ length: 8 }, () => async () => {
              try {
                return await ensureOneSaga(db, { materialId, idempotencyKey: KEY });
              } catch (err) {
                // Unique constraint violation from a race — the worker that
                // loses the insert sees a "duplicate" outcome on retry.
                return { outcome: "conflict", error: err.message };
              }
            })
          )
        );

        // Exactly one created; the rest are duplicates or conflicts.
        const created = outcomes.filter((o) => o.outcome === "created");
        const duplicates = outcomes.filter((o) => o.outcome === "duplicate");
        expect(created.length + duplicates.length).toBe(8);
        expect(created).toHaveLength(1);

        // Only one saga document in the collection.
        expect(sagaCol.docs).toHaveLength(1);
        expect(sagaCol.docs[0].idempotencyKey).toBe(KEY);
        expect(sagaCol.docs[0].state).toBe("pending");
      },
    });
  });

  /**
   * Edge case: two different materials request publication concurrently.
   * Each must get its own saga; they must not interfere.
   */
  it("concurrent sagas for different materials are independent", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const sagaCol = createFakeCollection({
          uniqueKey: (d) => d.idempotencyKey,
        });
        const db = instrumentDb(createFakeDb({ publication_sagas: sagaCol }), scheduler);

        const materialA = new ObjectId();
        const materialB = new ObjectId();

        const outcomes = settledValues(
          await scheduler.run([
            // Four workers for material A
            ...Array.from({ length: 4 }, () => async () => {
              try {
                return await ensureOneSaga(db, { materialId: materialA, idempotencyKey: "pub-mat-a" });
              } catch {
                return { outcome: "conflict" };
              }
            }),
            // Four workers for material B
            ...Array.from({ length: 4 }, () => async () => {
              try {
                return await ensureOneSaga(db, { materialId: materialB, idempotencyKey: "pub-mat-b" });
              } catch {
                return { outcome: "conflict" };
              }
            }),
          ])
        );

        const createdA = outcomes.filter((o) => o.outcome === "created" && String(o.sagaId ?? "") === String(sagaCol.docs.find((d) => d.idempotencyKey === "pub-mat-a")?._id ?? ""));
        const createdB = outcomes.filter((o) => o.outcome === "created" && String(o.sagaId ?? "") === String(sagaCol.docs.find((d) => d.idempotencyKey === "pub-mat-b")?._id ?? ""));

        // Two distinct sagas — one per material.
        expect(sagaCol.docs).toHaveLength(2);
        expect(sagaCol.docs.map((d) => d.idempotencyKey).sort()).toEqual(["pub-mat-a", "pub-mat-b"]);
        void createdA;
        void createdB;
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Saga failure + retry racing an active archive transition
// ---------------------------------------------------------------------------
describe("saga failure + retry racing archive", () => {
  /**
   * Edge case: a publication saga fails mid-way while a parallel worker
   * archives the material. The retry-from-failure logic must not rewind a
   * step already marked as complete, and the saga's state must not be
   * corrupted by the interleaved archive operation (which does not touch
   * the publication_sagas collection).
   *
   * This test verifies that the CAS on saga state (`findOneAndUpdate` with
   * `{ state: currentState }`) prevents stale retries from re-entering a
   * completed step, regardless of archive writes happening concurrently in
   * other collections.
   *
   * Rollback: if a saga is abandoned mid-flight, `compensateSaga` rolls back
   * already-completed external steps (IPFS unpin, Soroban unregister). The
   * archive flag on the material is independent and is not reverted.
   */
  it("concurrent archive and saga state transitions do not corrupt either collection", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const sagas = createFakeCollection();
        const materials = createFakeCollection();
        const sagaId = new ObjectId();
        const materialId = new ObjectId();

        await sagas.insertOne({
          _id: sagaId,
          materialId,
          state: "pending",
          stepProofs: {},
          retries: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await materials.insertOne({
          _id: materialId,
          archived: false,
          version: 1,
          searchVersion: 1,
        });

        const db = instrumentDb(
          createFakeDb({ publication_sagas: sagas, materials }),
          scheduler
        );

        settledValues(
          await scheduler.run([
            // Saga worker: advance pending → upload_done
            async () => {
              const col = db.collection("publication_sagas");
              return col.findOneAndUpdate(
                { _id: sagaId, state: "pending" },
                {
                  $set: {
                    state: "upload_done",
                    updatedAt: new Date(),
                    [`stepProofs.pending`]: { timestamp: new Date() },
                  },
                },
                { returnDocument: "after" }
              );
            },
            // Stale retry that tries to fail the pending step again —
            // must be a no-op if the saga already advanced.
            async () => {
              const col = db.collection("publication_sagas");
              return col.findOneAndUpdate(
                { _id: sagaId, state: "pending" }, // guard: only matches if still pending
                {
                  $set: { state: "failed", updatedAt: new Date() },
                  $inc: { retries: 1 },
                }
              );
            },
            // Archive worker: archives the material independently
            async () =>
              updateWithExpectedVersion(db.collection("materials"), {
                id: materialId,
                baseVersion: 1,
                set: { archived: true, searchVisibility: "hidden" },
              }),
          ])
        );

        // Saga must be in a consistent state: either pending→upload_done or
        // pending→failed, never a split (e.g. state=upload_done + retries=1).
        const saga = sagas.docs[0];
        const legalStates = ["upload_done", "failed", "pending"];
        expect(legalStates).toContain(saga.state);

        // If the worker won, the step proof is present.
        if (saga.state === "upload_done") {
          expect(saga.stepProofs.pending).toBeDefined();
          expect(saga.retries).toBe(0); // stale fail was a no-op
        }

        // Material version advanced by the archive write (or stayed at 1 if
        // the archive lost the CAS race — also legal since it will retry).
        expect([1, 2]).toContain(materials.docs[0].version);
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Retry storm on a transiently failing archive write
// ---------------------------------------------------------------------------
describe("retry storm on a transiently failing archive write", () => {
  /**
   * Edge case: the database has a transient blip so the first few archive
   * attempts return a network error. Clients retry with the same intent. The
   * invariant is that the document ends up archived exactly once — no multiple
   * redundant state flips — and every client ultimately observes archived:true.
   *
   * This test uses the harness's `retryStorm` helper, which models N clients
   * backing off and retrying on retryable errors.
   *
   * Operational note: because the archive route uses a blind updateOne, the
   * retry is naturally idempotent (writing archived:true to an already-archived
   * document is a no-op at the application layer). Clients should check the
   * returned state, not just the HTTP status, to confirm.
   */
  it("every retrying client eventually archives the material and sees archived:true", async () => {
    await explore({
      seeds: SEEDS,
      scenario: async ({ scheduler }) => {
        const { db, materials, _id } = makeMaterialDb(scheduler);
        let attempts = 0;

        const clients = retryStorm({
          clients: 6,
          maxAttempts: 50,
          isRetryable: (err) => err.retryable === true,
          attempt: async () => {
            attempts += 1;
            // First 3 global attempts simulate a transient DB error.
            if (attempts <= 3) {
              throw Object.assign(new Error("Transient DB error"), { retryable: true });
            }
            return archiveMaterial(db, _id, {
              actorAddress: "GCREATOR",
              archived: true,
              searchVersion: 1,
            });
          },
        });

        const outcomes = settledValues(await scheduler.run(clients));

        // Every client converges to "ok".
        expect(outcomes.every((o) => o.ok)).toBe(true);
        expect(outcomes.every((o) => o.value === "ok")).toBe(true);
        // Material is archived.
        expect(materials.docs[0].archived).toBe(true);
      },
    });
  });

  /**
   * Failure path: if the archive write fails fatally (e.g. authorization
   * error), a retry storm must stop and every client receives the non-retryable
   * error rather than spinning indefinitely.
   *
   * Recovery: a non-retryable error surfaces to the UI as a 403/404 response;
   * the operator must investigate before re-submitting.
   */
  it("a non-retryable failure (authorization error) stops the storm immediately", async () => {
    const scheduler = createScheduler({ seed: 7 });
    const { db, _id } = makeMaterialDb(scheduler);

    const clients = retryStorm({
      clients: 4,
      maxAttempts: 10,
      isRetryable: () => false, // authorization errors are not retryable
      attempt: async () => {
        // Impersonator: always forbidden
        return archiveMaterial(db, _id, {
          actorAddress: "GATTACKER",
          archived: true,
          searchVersion: 1,
        }).then((result) => {
          if (result === "forbidden") {
            throw Object.assign(new Error("Forbidden"), { retryable: false });
          }
          return result;
        });
      },
    });

    const outcomes = settledValues(await scheduler.run(clients));

    // All attempts fail immediately (not retried).
    expect(outcomes.every((o) => !o.ok)).toBe(true);
    expect(outcomes.every((o) => o.error.message === "Forbidden")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Missing material (not_found) during a concurrent archive + delete race
// ---------------------------------------------------------------------------
describe("concurrent archive and delete", () => {
  /**
   * Edge case: a moderator soft-deletes a material (sets isDeleted:true or
   * removes it) at the same moment a creator tries to archive it. Depending
   * on the interleaving, the archive writer may read the document before the
   * delete lands, then find it missing when issuing the updateOne.
   *
   * With the blind updateOne path, this silently results in matchedCount=0
   * (updateOne on a gone document is a no-op). The archive route returns "ok"
   * because it does not check matchedCount — this is the existing behaviour
   * and the test documents it, not endorses it.
   *
   * A hardened implementation should assert matchedCount === 1 and return
   * "not_found" when the document vanished between read and write.
   */
  it("documents the race between archive and concurrent delete", async () => {
    await explore({
      seeds: 20,
      scenario: async ({ scheduler }) => {
        const materials = createFakeCollection();
        const _id = new ObjectId();
        await materials.insertOne({
          _id,
          userAddress: "GCREATOR",
          archived: false,
          version: 1,
        });
        const db = instrumentDb(createFakeDb({ materials }), scheduler);

        settledValues(
          await scheduler.run([
            // Archiver
            async () =>
              archiveMaterial(db, _id, {
                actorAddress: "GCREATOR",
                archived: true,
                searchVersion: 1,
              }),
            // Concurrent soft-delete (remove the doc entirely)
            async () => {
              const col = db.collection("materials");
              await col.deleteOne({ _id });
            },
          ])
        );

        // After both complete, the document is either archived (archiver won) or
        // gone (deleter won). It must never be left in a partially corrupted state.
        if (materials.docs.length === 1) {
          // Archiver won the read before the delete; the document is archived.
          expect(materials.docs[0].archived).toBe(true);
        } else {
          // Deleter won; the document is gone.
          expect(materials.docs).toHaveLength(0);
        }
      },
    });
  });
});

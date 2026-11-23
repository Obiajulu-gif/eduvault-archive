import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  DEFAULT_BATCH_SIZE,
  MemoryCheckpointStore,
  REPAIR_STATUS,
  createOrphanRepairJob,
} from "../orphanRepair.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIds(count) {
  return Array.from({ length: count }, (_, i) => `orphan-${i}`);
}

function alwaysSucceed() {
  return async () => ({ ok: true });
}

function alwaysFail() {
  return async () => { throw new Error("repair failed"); };
}

function failFor(badIds) {
  return async (id) => {
    if (badIds.includes(id)) throw new Error(`cannot repair ${id}`);
    return { ok: true };
  };
}

// ---------------------------------------------------------------------------
// createOrphanRepairJob — validation
// ---------------------------------------------------------------------------

describe("createOrphanRepairJob validation", () => {
  it("throws when jobId is missing", () => {
    expect(() =>
      createOrphanRepairJob({ orphanIds: [], repairFn: alwaysSucceed(), checkpointStore: new MemoryCheckpointStore() })
    ).toThrow(TypeError);
  });

  it("throws when orphanIds is not an array", () => {
    expect(() =>
      createOrphanRepairJob({ jobId: "j1", orphanIds: null, repairFn: alwaysSucceed(), checkpointStore: new MemoryCheckpointStore() })
    ).toThrow(TypeError);
  });

  it("throws when repairFn is not a function", () => {
    expect(() =>
      createOrphanRepairJob({ jobId: "j1", orphanIds: [], repairFn: null, checkpointStore: new MemoryCheckpointStore() })
    ).toThrow(TypeError);
  });

  it("throws when checkpointStore is missing", () => {
    expect(() =>
      createOrphanRepairJob({ jobId: "j1", orphanIds: [], repairFn: alwaysSucceed() })
    ).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Normal run
// ---------------------------------------------------------------------------

describe("orphan repair — normal run", () => {
  it("processes all orphans and returns COMPLETED", async () => {
    const store = new MemoryCheckpointStore();
    const job = createOrphanRepairJob({
      jobId: "run-1",
      orphanIds: makeIds(5),
      repairFn: alwaysSucceed(),
      checkpointStore: store,
      batchSize: 2,
    });

    const summary = await job.run();

    expect(summary.status).toBe(REPAIR_STATUS.COMPLETED);
    expect(summary.processed).toBe(5);
    expect(summary.failed).toBe(0);
    expect(summary.total).toBe(5);
  });

  it("clears the checkpoint on completion", async () => {
    const store = new MemoryCheckpointStore();
    const job = createOrphanRepairJob({
      jobId: "run-clear",
      orphanIds: makeIds(3),
      repairFn: alwaysSucceed(),
      checkpointStore: store,
      batchSize: 10,
    });

    await job.run();
    expect(await store.load("run-clear")).toBeNull();
  });

  it("counts failed repairs without throwing", async () => {
    const store = new MemoryCheckpointStore();
    const job = createOrphanRepairJob({
      jobId: "run-fail",
      orphanIds: ["a", "b", "c"],
      repairFn: failFor(["b"]),
      checkpointStore: store,
    });

    const summary = await job.run();
    expect(summary.processed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.errors[0].id).toBe("b");
  });

  it("counts skipped when repairFn returns ok:false", async () => {
    const store = new MemoryCheckpointStore();
    const job = createOrphanRepairJob({
      jobId: "run-skip",
      orphanIds: ["x", "y"],
      repairFn: async (id) => (id === "x" ? { ok: false } : { ok: true }),
      checkpointStore: store,
    });

    const summary = await job.run();
    expect(summary.skipped).toBe(1);
    expect(summary.processed).toBe(1);
  });

  it("completes instantly for an empty list", async () => {
    const store = new MemoryCheckpointStore();
    const job = createOrphanRepairJob({
      jobId: "run-empty",
      orphanIds: [],
      repairFn: alwaysSucceed(),
      checkpointStore: store,
    });

    const summary = await job.run();
    expect(summary.status).toBe(REPAIR_STATUS.COMPLETED);
    expect(summary.processed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint / resume
// ---------------------------------------------------------------------------

describe("orphan repair — checkpointing and resume", () => {
  it("saves a checkpoint after each batch", async () => {
    const store = new MemoryCheckpointStore();
    const savespy = vi.spyOn(store, "save");

    const job = createOrphanRepairJob({
      jobId: "cp-1",
      orphanIds: makeIds(10),
      repairFn: alwaysSucceed(),
      checkpointStore: store,
      batchSize: 3,
    });

    await job.run();
    // 10 items, batchSize=3 → 4 batches (3+3+3+1)
    expect(savespy).toHaveBeenCalledTimes(4);
  });

  it("resumes from a checkpoint without reprocessing earlier items", async () => {
    const store = new MemoryCheckpointStore();
    // Simulate a previous run that completed 4 out of 6 items.
    await store.save("cp-resume", { nextIndex: 4, processed: 4, skipped: 0, failed: 0, errors: [] });

    const repaired = [];
    const job = createOrphanRepairJob({
      jobId: "cp-resume",
      orphanIds: makeIds(6),
      repairFn: async (id) => { repaired.push(id); return { ok: true }; },
      checkpointStore: store,
      batchSize: 10,
    });

    const summary = await job.run();
    // Only orphan-4 and orphan-5 should be processed this run.
    expect(repaired).toEqual(["orphan-4", "orphan-5"]);
    // Total includes the 4 from the previous checkpoint + 2 new.
    expect(summary.processed).toBe(6);
    expect(summary.resumed).toBe(true);
  });

  it("sets resumed:false on a fresh run", async () => {
    const store = new MemoryCheckpointStore();
    const job = createOrphanRepairJob({
      jobId: "cp-fresh",
      orphanIds: makeIds(2),
      repairFn: alwaysSucceed(),
      checkpointStore: store,
    });

    const summary = await job.run();
    expect(summary.resumed).toBe(false);
  });

  it("returns COMPLETED immediately when checkpoint shows all done", async () => {
    const store = new MemoryCheckpointStore();
    await store.save("cp-done", { nextIndex: 5, processed: 5, skipped: 0, failed: 0, errors: [] });

    const job = createOrphanRepairJob({
      jobId: "cp-done",
      orphanIds: makeIds(5),
      repairFn: alwaysSucceed(),
      checkpointStore: store,
    });

    const summary = await job.run();
    expect(summary.status).toBe(REPAIR_STATUS.COMPLETED);
    expect(summary.processed).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("orphan repair — cancellation", () => {
  it("stops processing and returns CANCELLED", async () => {
    const store = new MemoryCheckpointStore();
    let calls = 0;
    const job = createOrphanRepairJob({
      jobId: "cancel-1",
      orphanIds: makeIds(100),
      repairFn: async (id) => {
        calls++;
        return { ok: true };
      },
      checkpointStore: store,
      batchSize: 5,
    });

    // Cancel after the first batch completes by using onProgress
    let cancelledAfterFirst = false;
    const jobWithProgress = createOrphanRepairJob({
      jobId: "cancel-2",
      orphanIds: makeIds(100),
      repairFn: alwaysSucceed(),
      checkpointStore: new MemoryCheckpointStore(),
      batchSize: 5,
      onProgress: ({ nextIndex }) => {
        if (nextIndex >= 5 && !cancelledAfterFirst) {
          cancelledAfterFirst = true;
          jobWithProgress.cancel();
        }
      },
    });

    const summary = await jobWithProgress.run();
    expect(summary.status).toBe(REPAIR_STATUS.CANCELLED);
    expect(summary.processed).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// Progress callback
// ---------------------------------------------------------------------------

describe("orphan repair — progress callback", () => {
  it("fires after each batch", async () => {
    const store = new MemoryCheckpointStore();
    const events = [];
    const job = createOrphanRepairJob({
      jobId: "progress-1",
      orphanIds: makeIds(9),
      repairFn: alwaysSucceed(),
      checkpointStore: store,
      batchSize: 3,
      onProgress: (p) => events.push(p),
    });

    await job.run();
    expect(events).toHaveLength(3);
    expect(events[0].nextIndex).toBe(3);
    expect(events[2].nextIndex).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// MemoryCheckpointStore
// ---------------------------------------------------------------------------

describe("MemoryCheckpointStore", () => {
  it("saves and loads a checkpoint", async () => {
    const store = new MemoryCheckpointStore();
    await store.save("j1", { nextIndex: 10, processed: 10 });
    const cp = await store.load("j1");
    expect(cp.nextIndex).toBe(10);
    expect(cp.savedAt).toBeTruthy();
  });

  it("returns null for an unknown job", async () => {
    const store = new MemoryCheckpointStore();
    expect(await store.load("unknown")).toBeNull();
  });

  it("clears a checkpoint", async () => {
    const store = new MemoryCheckpointStore();
    await store.save("j1", { nextIndex: 5 });
    await store.clear("j1");
    expect(await store.load("j1")).toBeNull();
  });
});

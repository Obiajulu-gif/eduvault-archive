import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONFLICT_RESOLUTIONS,
  DEFAULT_QUEUE_CONFIG,
  OPERATION_STATUS,
  OperationConflictError,
  OperationError,
  OperationRetryableError,
  OperationTerminalError,
  computeBackoffMs,
  createOperationQueue,
  OPERATION_QUEUE_STORAGE_PREFIX,
} from "../operationQueue";
import { installLocalStorageStub } from "../../../../test/mocks/local-storage";

function makeQueue(overrides = {}) {
  return createOperationQueue({
    storage: window.localStorage,
    tabId: "tab-a",
    random: () => 0, // deterministic jitter for the whole suite
    disableBroadcast: true,
    ...overrides,
  });
}

function storageKeys() {
  const keys = [];
  for (let i = 0; i < window.localStorage.length; i += 1) keys.push(window.localStorage.key(i));
  return keys.filter((key) => key.startsWith(OPERATION_QUEUE_STORAGE_PREFIX));
}

describe("operationQueue — persistence across refresh/disconnect", () => {
  beforeEach(() => {
    installLocalStorageStub();
  });

  it("survives a refresh: a new queue instance rehydrates queued work", () => {
    const first = makeQueue();
    const operation = first.enqueue({ type: "material.archive", payload: { id: "mat-1" } });
    expect(operation.status).toBe(OPERATION_STATUS.PENDING);

    // Simulate a full page refresh: brand-new instance over the same storage.
    const second = makeQueue({ tabId: "tab-b" });
    const restored = second.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: operation.id, type: "material.archive", status: "pending" });
    expect(restored[0].payload).toEqual({ id: "mat-1" });
  });

  it("keeps pending work untouched when a drain runs offline", async () => {
    const queue = makeQueue();
    queue.enqueue({ type: "material.archive", payload: { id: "mat-1" } });
    const handler = vi.fn();

    const summary = await queue.drain({ handler, online: false });

    expect(summary).toMatchObject({ online: false, processed: 0 });
    expect(handler).not.toHaveBeenCalled();
    expect(queue.list()[0].status).toBe(OPERATION_STATUS.PENDING);
  });

  it("persists applied results so a refresh can still show them", async () => {
    const queue = makeQueue();
    queue.enqueue({ type: "purchase.submit", payload: { materialId: "mat-1" } });
    await queue.drain({ handler: async () => ({ purchaseId: "p-1" }) });

    const refreshed = makeQueue({ tabId: "tab-b" });
    const [operation] = refreshed.list();
    expect(operation.status).toBe(OPERATION_STATUS.APPLIED);
    expect(operation.result).toEqual({ purchaseId: "p-1" });
  });

  it("ignores corrupt rows instead of losing the whole queue", () => {
    window.localStorage.setItem(`${OPERATION_QUEUE_STORAGE_PREFIX}broken`, "{not-json");
    const queue = makeQueue();
    expect(queue.list()).toEqual([]);
    queue.enqueue({ type: "material.archive", payload: {} });
    expect(queue.list()).toHaveLength(1);
  });
});

describe("operationQueue — dedupe and determinism", () => {
  beforeEach(() => installLocalStorageStub());

  it("dedupes open work by key but allows a fresh enqueue after terminal state", async () => {
    const queue = makeQueue();
    const first = queue.enqueue({ type: "saved.toggle", dedupeKey: "save:mat-1", payload: { saved: true } });
    const second = queue.enqueue({ type: "saved.toggle", dedupeKey: "save:mat-1", payload: { saved: false } });

    expect(second.id).toBe(first.id);
    expect(queue.list()).toHaveLength(1);

    await queue.drain({ handler: async () => ({ ok: true }) });
    const third = queue.enqueue({ type: "saved.toggle", dedupeKey: "save:mat-1", payload: { saved: true } });
    expect(third.id).not.toBe(first.id);
    expect(queue.list()).toHaveLength(2);
  });

  it("backs off on retryable failures deterministically and fails after maxAttempts", async () => {
    let clock = 0;
    const queue = makeQueue({ now: () => clock, config: { maxAttempts: 3 } });
    queue.enqueue({ type: "webhook.send", payload: {} });
    const handler = vi.fn(async () => {
      throw new OperationRetryableError("gateway down", { code: "network_error" });
    });

    await queue.drain({ handler, at: () => clock });
    let [operation] = queue.list();
    expect(operation.status).toBe(OPERATION_STATUS.RETRY_SCHEDULED);
    expect(operation.attempts).toBe(1);
    expect(operation.nextAttemptAt).toBe(clock + 1000); // deterministic jitter=0

    // Not ready before the backoff elapses.
    expect((await queue.drain({ handler, at: () => clock })).processed).toBe(0);

    clock = operation.nextAttemptAt;
    await queue.drain({ handler, at: () => clock });
    [operation] = queue.list();
    expect(operation.attempts).toBe(2);
    expect(operation.nextAttemptAt).toBe(clock + 2000);

    clock = operation.nextAttemptAt;
    await queue.drain({ handler, at: () => clock });
    [operation] = queue.list();
    expect(operation.status).toBe(OPERATION_STATUS.FAILED); // maxAttempts reached
    expect(operation.attempts).toBe(3);
    expect(operation.lastError.code).toBe("network_error");
    expect(operation.completedAt).toBe(clock);
  });

  it("treats explicit terminal errors as immediate failures, unknown errors as retryable", async () => {
    const queue = makeQueue();
    queue.enqueue({ type: "quote", payload: {} });
    queue.enqueue({ type: "upload", payload: {} });

    await queue.drain({
      handler: async (operation) => {
        if (operation.type === "quote") throw new OperationTerminalError("quote expired", { code: "QUOTE_EXPIRED" });
        throw new Error("socket hang up");
      },
    });

    const [quote, upload] = [
      queue.list().find((op) => op.type === "quote"),
      queue.list().find((op) => op.type === "upload"),
    ];
    expect(quote.status).toBe(OPERATION_STATUS.FAILED);
    expect(upload.status).toBe(OPERATION_STATUS.RETRY_SCHEDULED);
  });

  it("computeBackoffMs is a pure function of attempts and injected randomness", () => {
    expect(computeBackoffMs(1, {}, () => 0)).toBe(1000);
    expect(computeBackoffMs(2, {}, () => 0)).toBe(2000);
    expect(computeBackoffMs(3, {}, () => 0)).toBe(4000);
    expect(computeBackoffMs(99, {}, () => 1)).toBe(
      Math.round(DEFAULT_QUEUE_CONFIG.maxBackoffMs * (1 + DEFAULT_QUEUE_CONFIG.jitterFraction)),
    );
  });
});

describe("operationQueue — stale-state conflict detection", () => {
  beforeEach(() => installLocalStorageStub());

  it("flags a version mismatch as a conflict without executing the handler", async () => {
    const queue = makeQueue();
    queue.enqueue({ type: "material.update", payload: { title: "Edited" }, baseVersion: 1 });
    const handler = vi.fn(async () => ({ ok: true }));

    const summary = await queue.drain({ handler, versionProvider: async () => 2 });

    expect(summary.conflicts).toBe(1);
    expect(handler).not.toHaveBeenCalled();
    const [operation] = queue.list();
    expect(operation.status).toBe(OPERATION_STATUS.CONFLICT);
    expect(operation.conflict).toMatchObject({ expectedVersion: 1, actualVersion: 2, type: "stale_state" });
  });

  it("supports deterministic retry (rebased) and discard resolution choices", async () => {
    const queue = makeQueue();
    const queued = queue.enqueue({ type: "material.update", payload: { title: "Edited" }, baseVersion: 1 });
    await queue.drain({ handler: async () => ({ ok: true }), versionProvider: async () => 7 });

    const retried = queue.resolveConflict(queued.id, CONFLICT_RESOLUTIONS.RETRY, { baseVersion: 7 });
    expect(retried.status).toBe(OPERATION_STATUS.PENDING);
    expect(retried.baseVersion).toBe(7);
    expect(retried.conflict).toBeNull();

    const handler = vi.fn(async () => ({ ok: true }));
    const summary = await queue.drain({ handler, versionProvider: async () => 7 });
    expect(summary.applied).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);

    // A second operation resolves by discarding and keeps its payload for rollback.
    const abandoned = queue.enqueue({ type: "material.update", payload: { title: "Other" }, baseVersion: 1 });
    await queue.drain({ handler: async () => ({ ok: true }), versionProvider: async () => 9 });
    const discarded = queue.resolveConflict(abandoned.id, CONFLICT_RESOLUTIONS.DISCARD);
    expect(discarded.status).toBe(OPERATION_STATUS.DISCARDED);
    expect(discarded.payload).toEqual({ title: "Other" });
    expect(queue.resolveConflict(abandoned.id, CONFLICT_RESOLUTIONS.DISCARD)).toBeNull();
    expect(() => queue.resolveConflict(abandoned.id, "explode")).toThrow(OperationError);
  });

  it("captures handler-reported conflicts with structured details", async () => {
    const queue = makeQueue();
    queue.enqueue({ type: "purchase.claim", payload: {} });

    await queue.drain({
      handler: async () => {
        throw new OperationConflictError("Already purchased in another tab", {
          expectedVersion: 0,
          actualVersion: 1,
          remoteState: { purchaseId: "p-9" },
        });
      },
    });

    const [operation] = queue.list();
    expect(operation.status).toBe(OPERATION_STATUS.CONFLICT);
    expect(operation.conflict.remoteState).toEqual({ purchaseId: "p-9" });
  });

  it("treats a failing version probe as retryable (never applies unverified work)", async () => {
    const queue = makeQueue();
    queue.enqueue({ type: "material.update", payload: {}, baseVersion: 3 });
    const handler = vi.fn(async () => ({ ok: true }));

    await queue.drain({
      handler,
      versionProvider: async () => {
        throw new Error("offline");
      },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(queue.list()[0].status).toBe(OPERATION_STATUS.RETRY_SCHEDULED);
  });
});

describe("operationQueue — multi-tab coordination", () => {
  beforeEach(() => installLocalStorageStub());

  it("leases operations so two tabs never execute the same work twice", async () => {
    let clock = 0;
    const tabA = makeQueue({ tabId: "tab-a", now: () => clock });
    const tabB = makeQueue({ tabId: "tab-b", now: () => clock });

    const operation = tabA.enqueue({ type: "purchase.submit", payload: { materialId: "mat-1" } });
    tabB.refreshFromStorage();
    expect(tabB.list()).toHaveLength(1);

    // Tab A claims the operation.
    const claimed = tabA.claim(operation.id);
    expect(claimed.status).toBe(OPERATION_STATUS.IN_FLIGHT);

    // Tab B does not consider leased work ready: it must not run it.
    tabB.refreshFromStorage();
    const handlerB = vi.fn(async () => ({ ok: true }));
    const summaryB = await tabB.drain({ handler: handlerB, at: () => clock });
    expect(handlerB).not.toHaveBeenCalled();
    expect(summaryB.processed).toBe(0);
    expect(tabB.claim(operation.id)).toBeNull();

    // The lease expires (tab A died) and tab B reclaims the work.
    clock += DEFAULT_QUEUE_CONFIG.leaseTtlMs + 1;
    const reclaimed = tabB.claim(operation.id);
    expect(reclaimed).toMatchObject({ status: OPERATION_STATUS.IN_FLIGHT, lease: { owner: "tab-b" } });

    tabB.markApplied(operation.id, { result: { purchaseId: "p-1" } });
    tabA.refreshFromStorage();
    expect(tabA.list()[0].status).toBe(OPERATION_STATUS.APPLIED);
  });

  it("only notifies subscribers when the persisted state actually changed", () => {
    const queue = makeQueue();
    const listener = vi.fn();
    queue.subscribe(listener);
    queue.refreshFromStorage();
    expect(listener).not.toHaveBeenCalled();
    queue.enqueue({ type: "noop", payload: {} });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("operationQueue — capacity and cleanup", () => {
  beforeEach(() => installLocalStorageStub());

  it("refuses new work at capacity while open operations are unresolved", () => {
    const queue = makeQueue({ config: { maxTrackedOperations: 2, retentionTerminalLimit: 1 } });
    queue.enqueue({ type: "a", payload: {} });
    queue.enqueue({ type: "b", payload: {} });
    expect(() => queue.enqueue({ type: "c", payload: {} })).toThrow(/queue is full/i);
  });

  it("evicts old terminal rows before refusing new work", async () => {
    const queue = makeQueue({ config: { maxTrackedOperations: 2, retentionTerminalLimit: 0 } });
    queue.enqueue({ type: "a", payload: {} });
    await queue.drain({ handler: async () => ({ ok: true }) });
    // Applied row is evicted on the next enqueue instead of counting toward capacity.
    const next = queue.enqueue({ type: "b", payload: {} });
    expect(next).toBeTruthy();
    expect(storageKeys().length).toBeLessThanOrEqual(2);
  });

  it("clearCompleted removes terminal rows but keeps open work", async () => {
    const queue = makeQueue();
    queue.enqueue({ type: "a", payload: {} });
    queue.enqueue({ type: "b", payload: {} });
    await queue.drain({ handler: async (operation) => operation.type });
    expect(queue.list().filter((op) => op.status === OPERATION_STATUS.APPLIED)).toHaveLength(2);
    queue.enqueue({ type: "c", payload: {} });

    const removed = queue.clearCompleted();
    expect(removed).toBe(2);
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0].type).toBe("c");
  });
});

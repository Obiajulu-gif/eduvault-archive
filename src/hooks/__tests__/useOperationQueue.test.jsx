import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useOperationQueue } from "../useOperationQueue";
import { createOperationQueue } from "@/lib/queue/operationQueue";
import { installLocalStorageStub } from "../../../test/mocks/local-storage";

function setNavigatorOnline(value) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => value,
  });
}

describe("useOperationQueue", () => {
  beforeEach(() => {
    installLocalStorageStub();
    setNavigatorOnline(true);
    vi.restoreAllMocks();
  });

  it("rehydrates queued work persisted by an earlier session", async () => {
    const seeded = createOperationQueue({
      storage: window.localStorage,
      tabId: "seeded",
      disableBroadcast: true,
      random: () => 0,
    });
    seeded.enqueue({ type: "resumed.op", payload: { id: 1 } });

    const { result } = renderHook(() => useOperationQueue({}));
    await waitFor(() => expect(result.current.operations).toHaveLength(1));
    expect(result.current.operations[0].type).toBe("resumed.op");
    expect(result.current.counts.open).toBe(1);
  });

  it("auto-drains queued operations through the supplied handler", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const { result } = renderHook(() => useOperationQueue({ handler }));

    act(() => {
      result.current.enqueue({ type: "saved.toggle", payload: { saved: true } });
    });

    await waitFor(() => expect(result.current.counts.applied).toBe(1));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe("saved.toggle");
    expect(result.current.lastSummary).not.toBeNull();
  });

  it("holds work while offline and flushes when connectivity returns", async () => {
    setNavigatorOnline(false);
    const handler = vi.fn(async () => ({ ok: true }));
    const { result } = renderHook(() => useOperationQueue({ handler }));

    act(() => {
      result.current.enqueue({ type: "purchase.submit", payload: { materialId: "mat-1" } });
    });

    await waitFor(() => expect(result.current.counts.open).toBe(1));
    expect(handler).not.toHaveBeenCalled();

    setNavigatorOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(result.current.counts.applied).toBe(1));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("surfaces stale-state conflicts with retry and discard choices", async () => {
    const version = { current: 1 };
    const handler = vi.fn(async () => ({ ok: true }));
    const { result } = renderHook(() =>
      useOperationQueue({ handler, versionProvider: async () => version.current }),
    );

    let operation;
    act(() => {
      operation = result.current.enqueue({
        type: "material.update",
        payload: { title: "Edited" },
        baseVersion: 1,
      });
      version.current = 2; // another tab changed the record before we flushed
    });

    await waitFor(() => expect(result.current.conflicts).toHaveLength(1));
    expect(handler).not.toHaveBeenCalled();
    expect(result.current.conflicts[0].conflict).toMatchObject({ expectedVersion: 1, actualVersion: 2 });

    act(() => {
      result.current.retryOperation(operation.id, { baseVersion: 2 });
    });

    await waitFor(() => expect(result.current.counts.applied).toBe(1));
    expect(handler).toHaveBeenCalledTimes(1);

    // Discard path is also exposed for the "keep server state" choice.
    const second = { current: 5 };
    act(() => {
      result.current.enqueue({ type: "material.update", payload: { title: "Other" }, baseVersion: 3 });
      second.current = 9;
    });
    await waitFor(() => expect(result.current.conflicts).toHaveLength(1));
    act(() => {
      result.current.discardOperation(result.current.conflicts[0].id);
    });
    await waitFor(() => expect(result.current.counts.discarded).toBe(1));
  });

  it("records storage failures instead of throwing at the caller", () => {
    const storage = {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    const { result } = renderHook(() => useOperationQueue({ storage }));

    act(() => {
      result.current.enqueue({ type: "material.archive", payload: {} });
    });

    expect(result.current.error?.code).toBe("queue_storage_unavailable");
    expect(result.current.operations).toHaveLength(0);
  });
});

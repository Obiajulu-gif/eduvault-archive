"use client";

/**
 * React binding for the conflict-aware offline / multi-tab operation queue
 * (`src/lib/queue/operationQueue.js`).
 *
 * Responsibilities kept in the hook (and out of the pure queue):
 * - subscribe the component tree via `useSyncExternalStore`;
 * - track `navigator.onLine` and auto-drain when connectivity returns;
 * - listen for `storage` events and BroadcastChannel pings from other tabs;
 * - keep a single in-flight drain per tab.
 *
 * Usage:
 *   const queue = useOperationQueue({
 *     handler: async (operation) => { ...perform the real request... },
 *     versionProvider: async (operation) => fetchCurrentVersion(operation),
 *   });
 *
 *   queue.enqueue({ type: "material.archive", payload: { id }, dedupeKey: `archive:${id}`, baseVersion });
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  CONFLICT_RESOLUTIONS,
  OPEN_OPERATION_STATUSES,
  OPERATION_QUEUE_CHANNEL,
  OPERATION_QUEUE_STORAGE_PREFIX,
  OPERATION_STATUS,
  createOperationQueue,
} from "@/lib/queue/operationQueue";

function browserOnline() {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return true;
  return navigator.onLine;
}

export function useOperationQueue({
  handler,
  versionProvider = null,
  autoDrain = true,
  config,
  storage,
  now,
  random,
  tabId,
} = {}) {
  const queue = useMemo(
    () => createOperationQueue({ config, storage, now, random, tabId }),
    // The queue lives for the component lifetime; re-creating it on config
    // identity changes would orphan in-flight leases, so it is intentionally
    // created once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const operations = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const [isOnline, setIsOnline] = useState(() => browserOnline());
  const [isDraining, setIsDraining] = useState(false);
  const [lastSummary, setLastSummary] = useState(null);
  const [error, setError] = useState(null);

  const handlerRef = useRef(handler);
  const versionProviderRef = useRef(versionProvider);
  const onlineRef = useRef(isOnline);
  const drainingRef = useRef(false);

  // Keep the latest handler/connectivity reachable from effects and event
  // handlers without re-subscribing them on every render. Refs are updated in
  // an effect (never during render) to satisfy the react-hooks rules and avoid
  // tearing under concurrent rendering.
  useEffect(() => {
    handlerRef.current = handler;
    versionProviderRef.current = versionProvider;
    onlineRef.current = isOnline;
  });

  const drainNow = useCallback(async () => {
    if (drainingRef.current) return null;
    if (typeof handlerRef.current !== "function") return null;
    drainingRef.current = true;
    setIsDraining(true);
    try {
      const summary = await queue.drain({
        handler: (operation) => handlerRef.current(operation),
        versionProvider: versionProviderRef.current
          ? (operation) => versionProviderRef.current(operation)
          : null,
        online: () => onlineRef.current,
      });
      setLastSummary(summary);
      return summary;
    } catch (drainError) {
      setError(drainError);
      return null;
    } finally {
      drainingRef.current = false;
      setIsDraining(false);
    }
  }, [queue]);

  // Connectivity tracking + auto-drain when the network comes back.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const goOnline = () => {
      setIsOnline(true);
      if (autoDrain) void drainNow();
    };
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [autoDrain, drainNow]);

  // Cross-tab synchronisation: another tab persisted or completed work.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const onStorage = (event) => {
      if (event?.key && !String(event.key).startsWith(OPERATION_QUEUE_STORAGE_PREFIX)) return;
      queue.refreshFromStorage();
    };
    window.addEventListener("storage", onStorage);

    let channel = null;
    if (typeof BroadcastChannel !== "undefined") {
      try {
        channel = new BroadcastChannel(OPERATION_QUEUE_CHANNEL);
        channel.onmessage = () => queue.refreshFromStorage();
      } catch {
        channel = null;
      }
    }

    return () => {
      window.removeEventListener("storage", onStorage);
      try {
        channel?.close();
      } catch {
        // ignore
      }
    };
  }, [queue]);

  // Drain once on mount and whenever the queue changes shape (e.g. a retry
  // became due, a refresh restored queued work) while online. The handler is
  // read through a ref so an inline function prop cannot retrigger the drain
  // effect on every render (which would loop with setLastSummary).
  const hasHandler = typeof handler === "function";
  useEffect(() => {
    if (!autoDrain || !isOnline || !hasHandler) return;
    void drainNow();
  }, [autoDrain, isOnline, hasHandler, operations, drainNow]);

  // Schedule the next wake-up for backoff-delayed retries so a queued
  // operation does not wait for an unrelated re-render to be replayed.
  useEffect(() => {
    if (!autoDrain || !isOnline) return undefined;
    const nextAttempt = operations
      .filter((op) => op.status === OPERATION_STATUS.RETRY_SCHEDULED || op.status === OPERATION_STATUS.PENDING)
      .map((op) => op.nextAttemptAt)
      .filter((value) => Number.isFinite(value));
    if (!nextAttempt.length) return undefined;
    const delayMs = Math.max(0, Math.min(Math.min(...nextAttempt) - Date.now(), 60_000));
    const timer = setTimeout(() => void drainNow(), delayMs);
    return () => clearTimeout(timer);
  }, [autoDrain, isOnline, operations, drainNow]);

  const enqueue = useCallback(
    (input) => {
      try {
        const operation = queue.enqueue(input);
        setError(null);
        return operation;
      } catch (enqueueError) {
        setError(enqueueError);
        return null;
      }
    },
    [queue],
  );

  const retryOperation = useCallback(
    (id, { baseVersion } = {}) => {
      const operation = queue.resolveConflict(id, CONFLICT_RESOLUTIONS.RETRY, { baseVersion });
      if (autoDrain && onlineRef.current) void drainNow();
      return operation;
    },
    [autoDrain, drainNow, queue],
  );

  const discardOperation = useCallback(
    (id) => queue.resolveConflict(id, CONFLICT_RESOLUTIONS.DISCARD),
    [queue],
  );

  const clearCompleted = useCallback(() => queue.clearCompleted(), [queue]);

  return {
    operations,
    openOperations: operations.filter((op) => OPEN_OPERATION_STATUSES.includes(op.status)),
    conflicts: operations.filter((op) => op.status === OPERATION_STATUS.CONFLICT),
    counts: queue.counts(),
    enqueue,
    drainNow,
    retryOperation,
    discardOperation,
    clearCompleted,
    refresh: queue.refreshFromStorage,
    isOnline,
    isDraining,
    lastSummary,
    error,
    storageKeyPrefix: OPERATION_QUEUE_STORAGE_PREFIX,
  };
}

export default useOperationQueue;

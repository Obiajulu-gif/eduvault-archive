"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Creator resource draft autosave (issue #340)
 *
 * - Persists draft changes automatically (debounced) to localStorage and, when
 *   an `endpoint` is supplied, to the server.
 * - Surfaces a clear autosave status (`idle` | `saving` | `saved` | `error`).
 * - Restores the draft after a page refresh via the `onRestore` callback.
 * - Surfaces save errors clearly through `error` / `status === "error"`.
 */

const STORAGE_PREFIX = "eduvault:draft:";

export function useDraftAutosave({
  draftId,
  value,
  onRestore,
  debounceMs = 1500,
  endpoint,
}) {
  const [status, setStatus] = useState("idle");
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [error, setError] = useState(null);
  const [hasDraft, setHasDraft] = useState(false);

  const serialized = JSON.stringify(value ?? {});
  const timerRef = useRef(null);
  const mountedRef = useRef(true);
  const restoredRef = useRef(false);
  const skipNextSaveRef = useRef(true);

  // Restore once on mount (localStorage first, then server if available).
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    async function restore() {
      let restoredValue = null;
      let source = "none";

      try {
        const raw = window.localStorage.getItem(STORAGE_PREFIX + draftId);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.value) {
            restoredValue = parsed.value;
            source = "local";
          }
        }
      } catch {
        // Corrupt draft in storage — ignore and continue.
      }

      if (!restoredValue && endpoint) {
        try {
          const res = await fetch(`${endpoint}?draftId=${encodeURIComponent(draftId)}`, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
          });
          if (res.ok) {
            const data = await res.json();
            if (data?.draft?.value) {
              restoredValue = data.draft.value;
              source = "server";
            }
          }
        } catch {
          // Server restore is best-effort.
        }
      }

      if (!cancelled && restoredValue && typeof onRestore === "function") {
        try {
          onRestore(restoredValue);
          setHasDraft(true);
        } catch {
          // Restoring into component state failed; keep status idle.
        }
      }
      restoredRef.current = true;
      skipNextSaveRef.current = true;
      if (mountedRef.current) setStatus("idle");
    }

    restore();
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  // Debounced autosave on every change after the initial restore.
  useEffect(() => {
    if (!restoredRef.current) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    setStatus("saving");
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      try {
        window.localStorage.setItem(
          STORAGE_PREFIX + draftId,
          JSON.stringify({ value: JSON.parse(serialized), savedAt: new Date().toISOString() })
        );

        if (endpoint) {
          const res = await fetch(endpoint, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ draftId, value: JSON.parse(serialized) }),
          });
          if (!res.ok) {
            throw new Error(`Save failed with status ${res.status}`);
          }
        }

        setHasDraft(true);
        setLastSavedAt(new Date());
        if (mountedRef.current) setStatus("saved");
      } catch (err) {
        setError(err?.message || "Failed to save draft");
        if (mountedRef.current) setStatus("error");
      }
    }, debounceMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized, draftId]);

  const clear = useCallback(() => {
    try {
      window.localStorage.removeItem(STORAGE_PREFIX + draftId);
    } catch {
      // ignore
    }
    setHasDraft(false);
    setLastSavedAt(null);
    setStatus("idle");
  }, [draftId]);

  return { status, lastSavedAt, error, hasDraft, clear };
}

"use client";

import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { materialService } from "@/services/materialService";

const STORAGE_KEY = "eduvault.recentlyViewed";
const PAUSE_STORAGE_KEY = "eduvault.recentlyViewed.pauseTracking";
const MAX_ITEMS = 12;
const EMPTY_IDS = [];

const listeners = new Set();
let idsCache = EMPTY_IDS;
let idsRawCache = null;
let pauseCache = false;
let pauseRawCache = null;

function notify() {
  for (const listener of listeners) listener();
}

function handleStorage(event) {
  if (event.key === STORAGE_KEY || event.key === PAUSE_STORAGE_KEY || event.key === null) {
    idsRawCache = null;
    pauseRawCache = null;
    notify();
  }
}

function subscribe(listener) {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

function getIdsSnapshot() {
  if (typeof window === "undefined") return EMPTY_IDS;
  let raw = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== idsRawCache) {
    idsRawCache = raw;
    if (!raw) {
      idsCache = EMPTY_IDS;
    } else {
      try {
        const parsed = JSON.parse(raw);
        idsCache = Array.isArray(parsed)
          ? parsed.map(String).filter(Boolean).slice(0, MAX_ITEMS)
          : EMPTY_IDS;
      } catch {
        idsCache = EMPTY_IDS;
      }
    }
  }
  return idsCache;
}

function getPauseSnapshot() {
  if (typeof window === "undefined") return false;
  let raw = null;
  try {
    raw = window.localStorage.getItem(PAUSE_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== pauseRawCache) {
    pauseRawCache = raw;
    pauseCache = raw === "true";
  }
  return pauseCache;
}

function storeIds(ids) {
  const normalized = ids.map(String).filter(Boolean).slice(0, MAX_ITEMS);
  idsCache = normalized;
  idsRawCache = JSON.stringify(normalized);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, idsRawCache);
    } catch {
    }
  }
  notify();
}

export function isRecentlyViewedPaused() {
  return getPauseSnapshot();
}

export function setRecentlyViewedPaused(paused) {
  pauseCache = Boolean(paused);
  pauseRawCache = String(pauseCache);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(PAUSE_STORAGE_KEY, pauseRawCache);
    } catch {
    }
  }
  notify();
}

export function clearRecentlyViewed() {
  storeIds([]);
}

export function removeRecentlyViewed(id) {
  const target = String(id ?? "");
  if (!target) return;
  const current = getIdsSnapshot();
  storeIds(current.filter((storedId) => storedId !== target));
}

export function trackRecentlyViewed(material) {
  if (typeof window === "undefined" || isRecentlyViewedPaused()) return;

  const id = String(material?._id || material?.id || material?.materialId || "");
  if (!id) return;

  const current = getIdsSnapshot();
  const filtered = current.filter((storedId) => storedId !== id);
  storeIds([id, ...filtered]);
}

export function useRecentlyViewed() {
  const storedIds = useSyncExternalStore(subscribe, getIdsSnapshot, () => EMPTY_IDS);
  const isTrackingPaused = useSyncExternalStore(subscribe, getPauseSnapshot, () => false);
  const ids = isTrackingPaused ? EMPTY_IDS : storedIds;

  const query = useQuery({
    queryKey: ["materials", "recently-viewed", isTrackingPaused ? "paused" : ids],
    queryFn: async () => {
      const results = [];
      for (const id of ids.slice(0, 6)) {
        try {
          const material = await materialService.getMaterialDetail(id);
          if (material) results.push(material);
        } catch {
        }
      }
      return results;
    },
    enabled: !isTrackingPaused && ids.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  return {
    ...query,
    items: isTrackingPaused ? [] : query.data || [],
    ids,
    isLoading: isTrackingPaused ? false : query.isLoading,
    isTrackingPaused,
    clearRecentlyViewed,
    removeRecentlyViewed,
    setRecentlyViewedPaused,
  };
}

/**
 * resourceArchive — client-side archive state for creator resources.
 *
 * Archiving hides a resource from the creator's default inventory listing
 * without deleting it or its history; a restore action brings it back.
 * State is persisted per browser in localStorage until a backend archive
 * API exists (there is currently none), so the helpers are SSR-safe and
 * fail closed (nothing archived) when storage is unavailable.
 */

const STORAGE_KEY = "eduvault.archivedResources";

function readStore() {
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeStore(ids) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage full or blocked — archive state simply won't persist.
  }
}

export function getArchivedIds() {
  return readStore();
}

export function isArchived(id) {
  return readStore().includes(id);
}

export function archiveResource(id) {
  if (!id) return getArchivedIds();
  const ids = readStore();
  if (!ids.includes(id)) {
    ids.push(id);
    writeStore(ids);
  }
  return ids;
}

export function restoreResource(id) {
  const ids = readStore().filter((existing) => existing !== id);
  writeStore(ids);
  return ids;
}

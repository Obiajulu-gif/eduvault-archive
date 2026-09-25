/**
 * resourceArchive — creator resource archive management.
 *
 * Archiving hides a resource from the creator's default inventory listing
 * and public marketplace discovery without deleting it or its purchase history;
 * a restore action brings it back.
 *
 * Persisted server-side via `/api/creator/materials/[id]/archive` with
 * localStorage used strictly as an optimistic-UI client cache.
 */

const STORAGE_KEY = "eduvault.archivedResources";

function readLocalStore() {
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeLocalStore(ids) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage full or blocked — optimistic cache won't persist
  }
}

export function getArchivedIds() {
  return readLocalStore();
}

export function isArchived(id) {
  return readLocalStore().includes(id);
}

/**
 * Archive a resource via backend API and update local optimistic cache.
 *
 * @param {string} id - Material ID to archive
 * @returns {Promise<string[]>} Updated list of archived IDs
 */
export async function archiveResource(id) {
  if (!id) return getArchivedIds();

  // Optimistic update
  const ids = readLocalStore();
  if (!ids.includes(id)) {
    ids.push(id);
    writeLocalStore(ids);
  }

  // Persist to backend API if in browser
  if (typeof window !== "undefined" && typeof fetch === "function") {
    try {
      const res = await fetch(`/api/creator/materials/${encodeURIComponent(id)}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      if (!res.ok) {
        // Rollback optimistic update on error
        const rolledBack = readLocalStore().filter((existing) => existing !== id);
        writeLocalStore(rolledBack);
        throw new Error("Failed to archive resource on backend");
      }
    } catch (err) {
      console.error("archiveResource API call failed:", err.message);
      throw err;
    }
  }

  return ids;
}

/**
 * Restore (un-archive) a resource via backend API and update local optimistic cache.
 *
 * @param {string} id - Material ID to restore
 * @returns {Promise<string[]>} Updated list of archived IDs
 */
export async function restoreResource(id) {
  if (!id) return getArchivedIds();

  // Optimistic update
  const ids = readLocalStore().filter((existing) => existing !== id);
  writeLocalStore(ids);

  // Persist to backend API if in browser
  if (typeof window !== "undefined" && typeof fetch === "function") {
    try {
      const res = await fetch(`/api/creator/materials/${encodeURIComponent(id)}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      if (!res.ok) {
        // Rollback optimistic update on error
        const rolledBack = readLocalStore();
        if (!rolledBack.includes(id)) {
          rolledBack.push(id);
          writeLocalStore(rolledBack);
        }
        throw new Error("Failed to restore resource on backend");
      }
    } catch (err) {
      console.error("restoreResource API call failed:", err.message);
      throw err;
    }
  }

  return ids;
}

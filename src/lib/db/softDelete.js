/**
 * Soft-delete handling for catalog listings.
 *
 * Hard-deleting a material document orphans the download references of everyone
 * who already bought it: the purchase row survives, the entitlement is still
 * valid on-chain, but the file the buyer paid for can no longer be resolved.
 * Retiring a listing therefore sets `isDeleted` instead of removing the row.
 *
 * The consequence is a split that the rest of the codebase has to respect:
 *
 *   - **Public catalog reads** exclude soft-deleted rows. That filter lives in
 *     `buildMarketplaceDiscoveryQuery` and in `activeCatalogFilter()` below, so
 *     there is one place to change it rather than one per endpoint.
 *   - **Entitlement-backed reads** — the download path — must *not* filter on
 *     `isDeleted`. A buyer's access does not lapse because the creator retired
 *     the listing. `src/app/api/download/route.js` looks materials up by id
 *     with no catalog filter, which is the behaviour to preserve.
 */

/**
 * Filter fragment matching only listings that belong in the public catalog.
 *
 * `$ne: true` rather than `false`: documents written before the field existed
 * have no `isDeleted` at all, and `{ isDeleted: false }` would exclude them.
 */
export function activeCatalogFilter() {
  return { isDeleted: { $ne: true } };
}

/** Merge the catalog filter into an existing query without clobbering it. */
export function withActiveCatalogFilter(query = {}) {
  return { ...query, ...activeCatalogFilter() };
}

/** True when a material document has been retired from the catalog. */
export function isSoftDeleted(material) {
  return material?.isDeleted === true;
}

/**
 * The `$set` payload that retires a listing.
 *
 * Kept as a builder so the soft-delete shape is identical wherever it is
 * applied — a creator retiring their own listing, an admin taking one down, or
 * a bulk moderation action.
 */
export function buildSoftDeletePatch({ deletedBy, reason, now = new Date() }) {
  return {
    isDeleted: true,
    deletedAt: now instanceof Date ? now : new Date(now),
    deletedBy: deletedBy ? String(deletedBy).slice(0, 300) : null,
    deletionReason: reason ? String(reason).slice(0, 1000) : null,
    updatedAt: now instanceof Date ? now : new Date(now),
  };
}

/**
 * The `$set` payload that restores a previously retired listing.
 *
 * `deletedAt` / `deletedBy` / `deletionReason` are cleared rather than left
 * behind, so a restored listing does not read as still-deleted to anything
 * inspecting those fields. The audit log keeps the history.
 */
export function buildRestorePatch({ now = new Date() } = {}) {
  return {
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
    deletionReason: null,
    updatedAt: now instanceof Date ? now : new Date(now),
  };
}

/**
 * Retire a listing.
 *
 * Returns `{ ok, reason }` rather than throwing so route handlers can map the
 * outcome onto a status code without a try/catch around normal flow.
 */
export async function softDeleteMaterial({
  db,
  filter,
  deletedBy,
  reason,
  now = new Date(),
}) {
  const materials = db.collection("materials");
  const existing = await materials.findOne(filter);

  if (!existing) return { ok: false, reason: "not_found" };
  if (isSoftDeleted(existing)) return { ok: false, reason: "already_deleted", material: existing };

  await materials.updateOne(filter, {
    $set: buildSoftDeletePatch({ deletedBy, reason, now }),
  });

  return { ok: true, material: existing };
}

/** Restore a previously retired listing. */
export async function restoreMaterial({ db, filter, now = new Date() }) {
  const materials = db.collection("materials");
  const existing = await materials.findOne(filter);

  if (!existing) return { ok: false, reason: "not_found" };
  if (!isSoftDeleted(existing)) return { ok: false, reason: "not_deleted", material: existing };

  await materials.updateOne(filter, { $set: buildRestorePatch({ now }) });

  return { ok: true, material: existing };
}

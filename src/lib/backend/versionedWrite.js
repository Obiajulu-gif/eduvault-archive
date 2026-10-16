/**
 * Optimistic-concurrency (compare-and-set on `version`) for single-document
 * writes. A write only lands if the document is still at the version the
 * caller based its change on, so stale clients and racing writers can never
 * silently overwrite each other (lost update).
 *
 * Documents written before versioning existed have no `version`; they are
 * treated as version 1.
 */

export const VERSIONED_WRITE = Object.freeze({
  UPDATED: "updated",
  CONFLICT: "conflict",
  NOT_FOUND: "not_found",
});

export function effectiveVersion(doc) {
  return doc?.version || 1;
}

/** Filter matching `_id` at exactly `version` (legacy unversioned docs count as 1). */
export function buildVersionFilter(id, version) {
  const versionClause =
    version === 1
      ? { $or: [{ version: 1 }, { version: { $exists: false } }, { version: null }] }
      : { version };
  return { _id: id, ...versionClause };
}

/**
 * Apply `set` iff the document is at `baseVersion`; bumps the version by one.
 *
 * @param {object} collection
 * @param {object} args
 * @param {*} args.id - document `_id`
 * @param {number} args.baseVersion - version the change was computed against
 *   (the client's `expectedVersion`, or the version just read)
 * @param {object} args.set - fields to set (version is managed here)
 * @param {object} [args.extraSet] - additional fields derived from the new
 *   version, e.g. `{ searchVersion }`; called with the next version
 * @returns {Promise<{status: string, doc?: object, currentVersion?: number, expectedVersion?: number}>}
 */
export async function updateWithExpectedVersion(collection, { id, baseVersion, set, extraSet }) {
  const nextVersion = baseVersion + 1;
  const result = await collection.findOneAndUpdate(
    buildVersionFilter(id, baseVersion),
    {
      $set: {
        ...set,
        version: nextVersion,
        ...(typeof extraSet === "function" ? extraSet(nextVersion) : {}),
      },
    },
    { returnDocument: "after" }
  );

  const doc = result?.value || result;
  if (doc) return { status: VERSIONED_WRITE.UPDATED, doc, nextVersion };

  const fresh = await collection.findOne({ _id: id });
  if (!fresh) return { status: VERSIONED_WRITE.NOT_FOUND };
  return {
    status: VERSIONED_WRITE.CONFLICT,
    currentVersion: effectiveVersion(fresh),
    expectedVersion: baseVersion,
  };
}

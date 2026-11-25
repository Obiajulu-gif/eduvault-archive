/**
 * Conflict Resolution for Concurrent Edits
 * Issue #1127: Build conflict resolution for concurrent edits
 *
 * Implements optimistic concurrency control with version vectors,
 * three-way merge for compatible changes, and deterministic conflict
 * detection when changes are incompatible.
 */

export const ConflictStrategy = {
  LAST_WRITE_WINS: "LAST_WRITE_WINS",
  THREE_WAY_MERGE: "THREE_WAY_MERGE",
  REJECT: "REJECT",
};

export const ConflictResolutionStatus = {
  MERGED: "MERGED",
  CONFLICT: "CONFLICT",
  REJECTED: "REJECTED",
};

export class ConcurrentEditConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ConcurrentEditConflictError";
    this.code = "EDIT_CONFLICT";
    this.details = details;
  }
}

export class StaleVersionError extends Error {
  constructor(message, { expected, actual } = {}) {
    super(message);
    this.name = "StaleVersionError";
    this.code = "STALE_VERSION";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Compare two version vectors.
 * Returns "ahead", "behind", "concurrent", or "equal".
 */
export function compareVersionVectors(a, b) {
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aAhead = false;
  let bAhead = false;

  for (const key of allKeys) {
    const aVal = a[key] ?? 0;
    const bVal = b[key] ?? 0;
    if (aVal > bVal) aAhead = true;
    if (bVal > aVal) bAhead = true;
  }

  if (!aAhead && !bAhead) return "equal";
  if (aAhead && !bAhead) return "ahead";
  if (!aAhead && bAhead) return "behind";
  return "concurrent";
}

/**
 * Merge two version vectors by taking the maximum at each key.
 */
export function mergeVersionVectors(a, b) {
  const result = { ...a };
  for (const [key, val] of Object.entries(b)) {
    result[key] = Math.max(result[key] ?? 0, val);
  }
  return result;
}

/**
 * Increment a node's clock in a version vector.
 */
export function incrementVersionVector(vector, nodeId) {
  return { ...vector, [nodeId]: (vector[nodeId] ?? 0) + 1 };
}

/**
 * Compute the diff between a base object and a modified object.
 * Returns a map of field → { from, to }.
 */
export function computeFieldDiff(base, modified) {
  const diff = {};
  const allKeys = new Set([...Object.keys(base), ...Object.keys(modified)]);
  for (const key of allKeys) {
    if (JSON.stringify(base[key]) !== JSON.stringify(modified[key])) {
      diff[key] = { from: base[key], to: modified[key] };
    }
  }
  return diff;
}

/**
 * Detect conflicting fields between two diffs against the same base.
 * Fields where both sides changed to different values are conflicts.
 */
export function detectFieldConflicts(diffA, diffB) {
  const conflicts = [];
  for (const field of Object.keys(diffA)) {
    if (field in diffB) {
      const toA = diffA[field].to;
      const toB = diffB[field].to;
      if (JSON.stringify(toA) !== JSON.stringify(toB)) {
        conflicts.push({ field, valueA: toA, valueB: toB });
      }
    }
  }
  return conflicts;
}

/**
 * Apply a diff to a base object, returning the patched result.
 */
export function applyDiff(base, diff) {
  const result = { ...base };
  for (const [field, change] of Object.entries(diff)) {
    if (change.to === undefined) {
      delete result[field];
    } else {
      result[field] = change.to;
    }
  }
  return result;
}

/**
 * Attempt a three-way merge.
 *
 * @param {object} base   - The common ancestor document
 * @param {object} editA  - First concurrent edit (full document)
 * @param {object} editB  - Second concurrent edit (full document)
 * @returns {{ status, merged, conflicts }}
 */
export function threeWayMerge(base, editA, editB) {
  const diffA = computeFieldDiff(base, editA);
  const diffB = computeFieldDiff(base, editB);
  const conflicts = detectFieldConflicts(diffA, diffB);

  if (conflicts.length > 0) {
    return { status: ConflictResolutionStatus.CONFLICT, merged: null, conflicts };
  }

  // No conflicts — apply both diffs (B on top of A, non-overlapping changes commute)
  const merged = applyDiff(applyDiff(base, diffA), diffB);
  return { status: ConflictResolutionStatus.MERGED, merged, conflicts: [] };
}

/**
 * Strip internal version-vector fields from a document object.
 */
function stripVectorFields(doc) {
  const { _versionVector, _baseVersionVector, _baseDocument, ...fields } = doc;
  return fields;
}

/**
 * Resolve a concurrent edit against the current stored document.
 *
 * @param {object} opts
 * @param {object} opts.current         - Current document state (with _versionVector)
 * @param {object} opts.incomingEdit    - The edit being applied (with _baseVersionVector;
 *                                        optionally _baseDocument for three-way merge)
 * @param {string} opts.editorId        - Logical node/session identifier for the editor
 * @param {ConflictStrategy} opts.strategy
 * @returns {{ status, document, conflicts, versionVector }}
 */
export function resolveEdit({
  current,
  incomingEdit,
  editorId,
  strategy = ConflictStrategy.THREE_WAY_MERGE,
}) {
  const currentVector = current._versionVector ?? {};
  const baseVector = incomingEdit._baseVersionVector ?? {};
  const relationship = compareVersionVectors(baseVector, currentVector);

  if (relationship === "ahead") {
    throw new StaleVersionError(
      "Incoming edit references a future version — possible data corruption",
      { expected: currentVector, actual: baseVector }
    );
  }

  // "equal" is the only truly safe fast path: the document has not changed since
  // the edit was based, so there is nothing to reconcile.
  if (relationship === "equal") {
    const updatedVector = incrementVersionVector(currentVector, editorId);
    const document = { ...current, ...stripVectorFields(incomingEdit), _versionVector: updatedVector };
    return { status: ConflictResolutionStatus.MERGED, document, conflicts: [], versionVector: updatedVector };
  }

  // "behind" means the edit is stale: the document has advanced past the base the
  // editor worked from.  This is NOT safe to fast-path — it must go through the
  // same strategy logic as a concurrent edit to avoid overwriting newer data.
  //
  // LAST_WRITE_WINS is the one strategy that intentionally discards server-side
  // changes, so stale edits are still accepted there.
  if (strategy === ConflictStrategy.LAST_WRITE_WINS) {
    const updatedVector = mergeVersionVectors(currentVector, baseVector);
    const nextVector = incrementVersionVector(updatedVector, editorId);
    const document = { ...current, ...stripVectorFields(incomingEdit), _versionVector: nextVector };
    return { status: ConflictResolutionStatus.MERGED, document, conflicts: [], versionVector: nextVector };
  }

  // For REJECT: both "behind" (stale) and "concurrent" edits are rejected.
  if (strategy === ConflictStrategy.REJECT) {
    const message =
      relationship === "behind"
        ? "Stale edit rejected: document has advanced past the base version"
        : "Concurrent edit rejected by policy";
    return {
      status: ConflictResolutionStatus.REJECTED,
      document: null,
      conflicts: [{ message }],
      versionVector: currentVector,
    };
  }

  // THREE_WAY_MERGE (default)
  //
  // We need a real common-ancestor document to diff against.  Callers should
  // include `_baseDocument` in the incoming edit — the snapshot of the document
  // at _baseVersionVector.  Without it we fall back to an empty-object base,
  // which is conservative: any field present in either current or the incoming
  // edit will appear as a "change from base" and conflicts will be detected.
  //
  // The earlier bug was `base = current`, which made computeFieldDiff(base, current)
  // always return an empty diff, so conflicting concurrent edits were never caught.
  const baseDocument = incomingEdit._baseDocument ?? {};
  const currentFields = stripVectorFields(current);
  const incomingFields = stripVectorFields(incomingEdit);

  const { status, merged, conflicts } = threeWayMerge(baseDocument, currentFields, incomingFields);

  if (status === ConflictResolutionStatus.CONFLICT) {
    return { status, document: null, conflicts, versionVector: currentVector };
  }

  const updatedVector = mergeVersionVectors(currentVector, baseVector);
  const nextVector = incrementVersionVector(updatedVector, editorId);
  const document = { ...merged, _versionVector: nextVector };
  return { status: ConflictResolutionStatus.MERGED, document, conflicts: [], versionVector: nextVector };
}

export default {
  ConflictStrategy,
  ConflictResolutionStatus,
  ConcurrentEditConflictError,
  StaleVersionError,
  compareVersionVectors,
  mergeVersionVectors,
  incrementVersionVector,
  computeFieldDiff,
  detectFieldConflicts,
  applyDiff,
  threeWayMerge,
  resolveEdit,
};

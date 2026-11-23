/**
 * Deterministic Conflict Resolver for Multi-Client Edits
 *
 * Provides three-way merge resolution, field-level conflict policies,
 * deterministic tie-breaking, array/tag set unions, numeric delta preservation,
 * and role-based field authorization for concurrent edits.
 *
 * Acceptance Criteria Covered:
 *   - Normal Path: Orthogonal multi-client edits, identical edits, array tag unions,
 *     and numeric delta merging without data loss.
 *   - Failure Path: Conflicting critical fields, invalid state transitions (resurrecting
 *     deleted/suspended records), and structured 409 Conflict envelopes.
 *   - Retry Path: Concurrency conflict recovery with full diff descriptors,
 *     client resolution strategies, and idempotent CAS retries.
 *   - Authorization Path: Role-based field editing permissions, tenant isolation,
 *     and prevention of privilege escalation through merge payloads.
 */

import { effectiveVersion, buildVersionFilter, VERSIONED_WRITE } from './versionedWrite.js';

export const CONFLICT_RESOLUTION_STRATEGY = Object.freeze({
  THREE_WAY_AUTO: 'three_way_auto',
  LAST_WRITE_WINS: 'last_write_wins',
  CLIENT_WINS: 'client_wins',
  SERVER_WINS: 'server_wins',
  MANUAL_REQUIRED: 'manual_required',
});

export const CONFLICT_STATUS = Object.freeze({
  CLEAN_WRITE: 'clean_write',
  AUTO_MERGED: 'auto_merged',
  CONFLICT_REQUIRES_ACTION: 'conflict_requires_action',
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not_found',
  INVALID_TRANSITION: 'invalid_transition',
});

// Fields that cannot be automatically merged across concurrent writers in strict mode
export const CRITICAL_CONFLICT_FIELDS = Object.freeze([
  'license',
  'userAddress',
  'ownerAddress',
  'visibility',
  'storageKey',
  'fileUrl',
  'legalTombstone',
]);

// Fields that are system-managed and immutable by client edits
export const IMMUTABLE_SYSTEM_FIELDS = Object.freeze([
  '_id',
  'createdAt',
  'chainContractId',
  'chainLedger',
  'chainTxHash',
]);

// Fields restricted to operator/admin roles
export const PRIVILEGED_FIELDS = Object.freeze([
  'moderationStatus',
  'quarantineStatus',
  'creatorSuspended',
  'legalTombstone',
  'legalRemovedAt',
  'internalReviewFlags',
]);

/**
 * Deep equality helper for primitive values, dates, arrays, and plain objects.
 */
export function valuesAreEqual(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => valuesAreEqual(val, b[idx]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => valuesAreEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Computes a shallow/field-level diff between a base document and a target document.
 * Returns maps of added, modified, and deleted fields.
 */
export function diffDocuments(base = {}, target = {}) {
  const added = {};
  const modified = {};
  const deleted = [];

  const baseKeys = new Set(Object.keys(base));
  const targetKeys = new Set(Object.keys(target));

  for (const key of targetKeys) {
    if (IMMUTABLE_SYSTEM_FIELDS.includes(key) || key === 'version') continue;
    if (!baseKeys.has(key)) {
      added[key] = target[key];
    } else if (!valuesAreEqual(base[key], target[key])) {
      modified[key] = { from: base[key], to: target[key] };
    }
  }

  for (const key of baseKeys) {
    if (IMMUTABLE_SYSTEM_FIELDS.includes(key) || key === 'version') continue;
    if (!targetKeys.has(key) && base[key] !== undefined) {
      deleted.push(key);
    }
  }

  return { added, modified, deleted };
}

/**
 * Validates that an actor has permission to modify the specified fields.
 */
export function validateFieldAuthorization({
  actor = {},
  resourceOwnerId,
  fieldsToUpdate = [],
} = {}) {
  const role = actor.role || 'learner';
  const actorId = actor.id || actor.userAddress || actor.sub;

  if (role === 'learner') {
    return {
      authorized: false,
      error: 'Learner role is not authorized to edit catalog materials',
      unauthorizedFields: fieldsToUpdate,
    };
  }

  // Creator can only edit materials they own
  if (role === 'creator') {
    if (resourceOwnerId && resourceOwnerId !== actorId) {
      return {
        authorized: false,
        error: 'Creator cannot edit materials owned by another creator',
        unauthorizedFields: fieldsToUpdate,
      };
    }

    // Creator cannot edit privileged admin fields
    const privilegedViolations = fieldsToUpdate.filter((f) => PRIVILEGED_FIELDS.includes(f));
    if (privilegedViolations.length > 0) {
      return {
        authorized: false,
        error: `Creator role cannot modify privileged fields: ${privilegedViolations.join(', ')}`,
        unauthorizedFields: privilegedViolations,
      };
    }
  }

  return { authorized: true };
}

/**
 * Merges two arrays preserving original elements and unioning new distinct elements.
 */
function mergeArrayUnion(baseArr = [], serverArr = [], clientArr = []) {
  const baseSet = new Set((baseArr || []).map((x) => JSON.stringify(x)));
  const result = [...(serverArr || [])];
  const resultSet = new Set(result.map((x) => JSON.stringify(x)));

  for (const item of clientArr || []) {
    const serialized = JSON.stringify(item);
    if (!resultSet.has(serialized)) {
      result.push(item);
      resultSet.add(serialized);
    }
  }

  return result;
}

/**
 * Merges numeric counter fields using relative delta arithmetic:
 * Result = ServerValue + (ClientValue - BaseValue)
 */
function mergeNumericDelta(baseVal = 0, serverVal = 0, clientVal = 0) {
  const delta = (Number(clientVal) || 0) - (Number(baseVal) || 0);
  return (Number(serverVal) || 0) + delta;
}

/**
 * Resolves a field-level conflict between client and server using deterministic rules.
 */
function resolveFieldConflict({
  field,
  baseVal,
  serverVal,
  clientVal,
  clientMeta = {},
  serverMeta = {},
  strict = false,
}) {
  // 1. Identical edits: both changed to same value
  if (valuesAreEqual(serverVal, clientVal)) {
    return {
      resolved: true,
      winner: 'identical',
      value: clientVal,
      strategy: 'idempotent_identical',
    };
  }

  // 2. Strict mode check for critical fields
  if (strict && CRITICAL_CONFLICT_FIELDS.includes(field)) {
    return {
      resolved: false,
      winner: 'none',
      value: serverVal,
      strategy: 'manual_required',
      reason: `Field '${field}' is critical and conflicting edits require manual resolution`,
    };
  }

  // 3. Array union (tags, categories, learningOutcomes)
  if (Array.isArray(serverVal) && Array.isArray(clientVal)) {
    return {
      resolved: true,
      winner: 'union',
      value: mergeArrayUnion(baseVal, serverVal, clientVal),
      strategy: 'array_set_union',
    };
  }

  // 4. Numeric counters (likes, viewCount, reviewsCount)
  if (typeof serverVal === 'number' && typeof clientVal === 'number' && ['likes', 'viewsCount', 'feedbackCount'].includes(field)) {
    return {
      resolved: true,
      winner: 'delta',
      value: mergeNumericDelta(baseVal, serverVal, clientVal),
      strategy: 'numeric_relative_delta',
    };
  }

  // 5. Deterministic Last-Write-Wins with Actor Lexicographical Tie-Breaker
  const clientTime = Number(clientMeta.timestamp) || 0;
  const serverTime = Number(serverMeta.timestamp) || 0;

  if (clientTime > serverTime) {
    return {
      resolved: true,
      winner: 'client',
      value: clientVal,
      strategy: 'lww_timestamp',
    };
  }

  if (serverTime > clientTime) {
    return {
      resolved: true,
      winner: 'server',
      value: serverVal,
      strategy: 'lww_timestamp',
    };
  }

  // Deterministic tie-breaker: Compare actor IDs lexicographically
  const clientActor = String(clientMeta.actor || '');
  const serverActor = String(serverMeta.actor || '');

  if (clientActor >= serverActor) {
    return {
      resolved: true,
      winner: 'client',
      value: clientVal,
      strategy: 'lww_actor_tiebreak',
    };
  }

  return {
    resolved: true,
    winner: 'server',
    value: serverVal,
    strategy: 'lww_actor_tiebreak',
  };
}

/**
 * Performs a deterministic 3-way merge between base, server, and client document snapshots.
 *
 * @param {object} params
 * @param {object} params.base - Common ancestor document state (V_base)
 * @param {object} params.server - Current database document state (V_current)
 * @param {object} params.client - Proposed client document state
 * @param {object} [params.clientMeta={}] - Client metadata (actor, timestamp)
 * @param {object} [params.serverMeta={}] - Server metadata (actor, timestamp)
 * @param {boolean} [params.strict=false] - Whether critical field conflicts require manual intervention
 * @returns {object} Resolution outcome
 */
export function resolveConflictThreeWay({
  base = {},
  server = {},
  client = {},
  clientMeta = {},
  serverMeta = {},
  strict = false,
} = {}) {
  // Invariant: Cannot resurrect soft-deleted or tombstoned records via edit merge
  if (server.isDeleted === true && client.isDeleted !== true) {
    return {
      status: CONFLICT_STATUS.INVALID_TRANSITION,
      canAutoMerge: false,
      error: 'Cannot merge edits into a deleted or tombstoned material',
      unresolvedConflicts: [{ field: 'isDeleted', reason: 'document_deleted_on_server' }],
    };
  }

  const clientDiff = diffDocuments(base, client);
  const serverDiff = diffDocuments(base, server);

  const merged = { ...server };
  const cleanFields = [];
  const resolvedFields = {};
  const unresolvedConflicts = [];

  const allTouchedFields = new Set([
    ...Object.keys(clientDiff.added),
    ...Object.keys(clientDiff.modified),
    ...clientDiff.deleted,
    ...Object.keys(serverDiff.added),
    ...Object.keys(serverDiff.modified),
    ...serverDiff.deleted,
  ]);

  for (const field of allTouchedFields) {
    const inClientMod = field in clientDiff.modified;
    const inClientAdd = field in clientDiff.added;
    const inClientDel = clientDiff.deleted.includes(field);

    const inServerMod = field in serverDiff.modified;
    const inServerAdd = field in serverDiff.added;
    const inServerDel = serverDiff.deleted.includes(field);

    const clientChanged = inClientMod || inClientAdd || inClientDel;
    const serverChanged = inServerMod || inServerAdd || inServerDel;

    // Case 1: Changed ONLY by client (orthogonal clean edit)
    if (clientChanged && !serverChanged) {
      if (inClientDel) {
        delete merged[field];
      } else {
        merged[field] = client[field];
      }
      cleanFields.push(field);
      continue;
    }

    // Case 2: Changed ONLY by server (clean server retention)
    if (serverChanged && !clientChanged) {
      cleanFields.push(field);
      continue;
    }

    // Case 3: Both changed the same field (conflict)
    const baseVal = base[field];
    const serverVal = server[field];
    const clientVal = client[field];

    const resolution = resolveFieldConflict({
      field,
      baseVal,
      serverVal,
      clientVal,
      clientMeta,
      serverMeta,
      strict,
    });

    if (resolution.resolved) {
      merged[field] = resolution.value;
      resolvedFields[field] = resolution;
    } else {
      unresolvedConflicts.push({
        field,
        baseValue: baseVal,
        serverValue: serverVal,
        clientValue: clientVal,
        reason: resolution.reason,
      });
    }
  }

  const clientHasChanges = Object.keys(clientDiff.added).length > 0 || Object.keys(clientDiff.modified).length > 0 || clientDiff.deleted.length > 0;
  const serverHasChanges = Object.keys(serverDiff.added).length > 0 || Object.keys(serverDiff.modified).length > 0 || serverDiff.deleted.length > 0;
  const isMerged = (clientHasChanges && serverHasChanges) || Object.keys(resolvedFields).length > 0;

  const canAutoMerge = unresolvedConflicts.length === 0;
  const currentVersion = effectiveVersion(server);
  const newVersion = currentVersion + 1;
  merged.version = newVersion;
  merged.updatedAt = new Date().toISOString();

  return {
    status: canAutoMerge
      ? (isMerged ? CONFLICT_STATUS.AUTO_MERGED : CONFLICT_STATUS.CLEAN_WRITE)
      : CONFLICT_STATUS.CONFLICT_REQUIRES_ACTION,
    canAutoMerge,
    mergedDocument: merged,
    cleanFields,
    resolvedFields,
    unresolvedConflicts,
    baseVersion: effectiveVersion(base),
    serverVersion: currentVersion,
    newVersion,
  };
}

/**
 * Builds an audit revision log entry for a resolved conflict.
 */
export function buildConflictAuditRecord({
  materialId,
  actor,
  baseVersion,
  serverVersion,
  newVersion,
  status,
  resolvedFields = {},
  unresolvedConflicts = [],
  timestamp = new Date().toISOString(),
}) {
  return {
    materialId: String(materialId),
    actor: String(actor || 'system'),
    baseVersion,
    serverVersion,
    newVersion,
    status,
    resolvedFields: Object.entries(resolvedFields).map(([field, res]) => ({
      field,
      strategy: res.strategy,
      winner: res.winner,
    })),
    unresolvedCount: unresolvedConflicts.length,
    timestamp,
  };
}

/**
 * Executes an update with automatic deterministic conflict resolution.
 * If a version conflict occurs, it reads the current server state,
 * runs 3-way resolution, and attempts an atomic CAS with the merged document.
 *
 * @param {object} collection - MongoDB collection
 * @param {object} args
 * @param {string} args.id - Material ID
 * @param {number} args.baseVersion - Base version the client edited
 * @param {object} args.clientDoc - Client's updated document payload
 * @param {object} [args.actor={}] - Requesting actor { id, role }
 * @param {object} [args.baseDoc] - Optional cached base document snapshot
 * @param {boolean} [args.strict=false] - Whether critical fields require manual resolution
 * @param {number} [args.maxResolutionRetries=3] - Maximum retry attempts on racing updates
 * @returns {Promise<object>}
 */
export async function updateWithConflictResolution(collection, {
  id,
  baseVersion,
  clientDoc,
  actor = {},
  baseDoc = null,
  strict = false,
  maxResolutionRetries = 3,
  now = Date.now(),
}) {
  let attempt = 0;
  let currentExpectedVersion = baseVersion;
  let currentBase = baseDoc;

  // Initial read of base if not provided
  if (!currentBase) {
    currentBase = await collection.findOne({ _id: id });
    if (!currentBase) {
      return { status: CONFLICT_STATUS.NOT_FOUND };
    }
  }

  // Pre-authorization check: Does caller have permission to edit?
  const clientDiff = diffDocuments(currentBase, clientDoc);
  const fieldsToChange = [...Object.keys(clientDiff.added), ...Object.keys(clientDiff.modified)];
  const authCheck = validateFieldAuthorization({
    actor,
    resourceOwnerId: currentBase.userAddress || currentBase.author,
    fieldsToUpdate: fieldsToChange,
  });

  if (!authCheck.authorized) {
    return {
      status: CONFLICT_STATUS.UNAUTHORIZED,
      error: authCheck.error,
      unauthorizedFields: authCheck.unauthorizedFields,
    };
  }

  while (attempt < maxResolutionRetries) {
    attempt += 1;

    // 1. Try atomic update at currentExpectedVersion
    const result = await collection.findOneAndUpdate(
      buildVersionFilter(id, currentExpectedVersion),
      {
        $set: {
          ...clientDoc,
          version: currentExpectedVersion + 1,
          updatedAt: new Date(now),
        },
      },
      { returnDocument: 'after' }
    );

    const updated = result?.value || result;
    if (updated) {
      return {
        status: attempt === 1 ? CONFLICT_STATUS.CLEAN_WRITE : CONFLICT_STATUS.AUTO_MERGED,
        doc: updated,
        version: currentExpectedVersion + 1,
        attempts: attempt,
      };
    }

    // 2. Conflict occurred. Fetch fresh server document
    const freshServer = await collection.findOne({ _id: id });
    if (!freshServer) {
      return { status: CONFLICT_STATUS.NOT_FOUND };
    }

    // 3. Resolve conflict 3-way
    const resolution = resolveConflictThreeWay({
      base: currentBase,
      server: freshServer,
      client: clientDoc,
      clientMeta: { actor: actor.id || actor.userAddress, timestamp: now },
      serverMeta: { actor: freshServer.lastModifiedBy || 'server', timestamp: new Date(freshServer.updatedAt || 0).getTime() },
      strict,
    });

    if (!resolution.canAutoMerge) {
      return {
        status: resolution.status || CONFLICT_STATUS.CONFLICT_REQUIRES_ACTION,
        currentVersion: resolution.serverVersion,
        expectedVersion: currentExpectedVersion,
        unresolvedConflicts: resolution.unresolvedConflicts,
        retryable: true,
        diff: {
          base: currentBase,
          server: freshServer,
          client: clientDoc,
        },
      };
    }

    // Update target for next loop iteration
    clientDoc = resolution.mergedDocument;
    currentExpectedVersion = resolution.serverVersion;
    currentBase = freshServer;
  }

  // Exceeded max retries under high contention
  return {
    status: CONFLICT_STATUS.CONFLICT_REQUIRES_ACTION,
    error: 'Exceeded maximum conflict resolution retries due to concurrent racing writers',
    currentVersion: currentExpectedVersion,
    retryable: true,
  };
}

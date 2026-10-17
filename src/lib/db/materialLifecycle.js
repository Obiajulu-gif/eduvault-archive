import { auditLog } from '../api/audit.js';

export const MaterialLifecycleState = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  PAUSED: 'paused',
  ARCHIVED: 'archived',
  SUSPENDED: 'suspended',
  RETIRED: 'retired',
  REMOVED: 'removed'
};

export const VALID_TRANSITIONS = {
  [MaterialLifecycleState.DRAFT]: [MaterialLifecycleState.ACTIVE],
  [MaterialLifecycleState.ACTIVE]: [
    MaterialLifecycleState.PAUSED,
    MaterialLifecycleState.ARCHIVED,
    MaterialLifecycleState.SUSPENDED,
    MaterialLifecycleState.RETIRED,
    MaterialLifecycleState.REMOVED
  ],
  [MaterialLifecycleState.PAUSED]: [
    MaterialLifecycleState.ACTIVE,
    MaterialLifecycleState.ARCHIVED,
    MaterialLifecycleState.SUSPENDED,
    MaterialLifecycleState.RETIRED,
    MaterialLifecycleState.REMOVED
  ],
  [MaterialLifecycleState.ARCHIVED]: [
    MaterialLifecycleState.ACTIVE,
    MaterialLifecycleState.RETIRED,
    MaterialLifecycleState.SUSPENDED,
    MaterialLifecycleState.REMOVED
  ],
  [MaterialLifecycleState.SUSPENDED]: [
    MaterialLifecycleState.ACTIVE, // If moderation overturned
    MaterialLifecycleState.REMOVED
  ],
  [MaterialLifecycleState.RETIRED]: [
    MaterialLifecycleState.ACTIVE, // Restored
    MaterialLifecycleState.REMOVED
  ],
  [MaterialLifecycleState.REMOVED]: [] // Terminal
};

/** States with no outgoing transitions. Derived so the table stays the single source of truth. */
export const TERMINAL_STATES = Object.freeze(
  Object.keys(VALID_TRANSITIONS).filter((state) => VALID_TRANSITIONS[state].length === 0)
);

export const LIFECYCLE_ERROR_CODES = Object.freeze({
  INVALID_TRANSITION: 'INVALID_LIFECYCLE_TRANSITION',
  CONCURRENT_MODIFICATION: 'LIFECYCLE_CONCURRENT_MODIFICATION',
  NOT_FOUND: 'MATERIAL_NOT_FOUND'
});

function lifecycleError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * Same-state is a legal no-op for known states; unknown states are never valid,
 * so corrupt data cannot slip through the identity check.
 */
export function isValidTransition(currentState, nextState) {
  const from = currentState || MaterialLifecycleState.DRAFT;
  if (!Object.hasOwn(VALID_TRANSITIONS, from) || !Object.hasOwn(VALID_TRANSITIONS, nextState)) return false;
  if (from === nextState) return true;
  return VALID_TRANSITIONS[from].includes(nextState);
}

export async function transitionMaterialState(db, materialId, nextState, { actor, reason, eventDetails = {} } = {}) {
  const materials = db.collection('materials');
  const material = await materials.findOne({ _id: materialId });
  if (!material) {
    throw lifecycleError('Material not found', LIFECYCLE_ERROR_CODES.NOT_FOUND);
  }

  const currentState = material.lifecycleState || MaterialLifecycleState.DRAFT;
  if (!isValidTransition(currentState, nextState)) {
    throw lifecycleError(
      `Invalid lifecycle transition from ${currentState} to ${nextState}`,
      LIFECYCLE_ERROR_CODES.INVALID_TRANSITION
    );
  }

  // Idempotent no-op: a repeated request must not rewrite deletion/audit metadata.
  if (currentState === nextState) {
    return material;
  }

  const patch = {
    lifecycleState: nextState,
    updatedAt: new Date()
  };

  // Backwards compatibility mappings for older code expecting scattered booleans
  if (nextState === MaterialLifecycleState.RETIRED) {
    patch.isDeleted = true;
    patch.deletedAt = new Date();
    patch.deletedBy = actor ? String(actor) : null;
    patch.deletionReason = reason ? String(reason) : null;
  } else if (currentState === MaterialLifecycleState.RETIRED && nextState !== MaterialLifecycleState.RETIRED) {
    patch.isDeleted = false;
    patch.deletedAt = null;
    patch.deletedBy = null;
    patch.deletionReason = null;
  }

  if (nextState === MaterialLifecycleState.ARCHIVED) {
    patch.archived = true;
  } else if (currentState === MaterialLifecycleState.ARCHIVED && nextState !== MaterialLifecycleState.ARCHIVED) {
    patch.archived = false;
  }

  if (nextState === MaterialLifecycleState.SUSPENDED) {
    patch.moderationStatus = 'suspended';
  } else if (currentState === MaterialLifecycleState.SUSPENDED && nextState !== MaterialLifecycleState.SUSPENDED) {
    patch.moderationStatus = 'approved';
  }

  if (nextState === MaterialLifecycleState.REMOVED) {
    patch.legalTombstone = true;
  }

  // Compare-and-set on the state we validated against, so a concurrent writer
  // can never turn a legal transition into an illegal one. Legacy documents
  // without a lifecycleState are treated as draft.
  const stateGuard =
    currentState === MaterialLifecycleState.DRAFT
      ? {
          $or: [
            { lifecycleState: MaterialLifecycleState.DRAFT },
            { lifecycleState: { $exists: false } },
            { lifecycleState: null }
          ]
        }
      : { lifecycleState: currentState };
  const writeResult = await materials.updateOne({ _id: materialId, ...stateGuard }, { $set: patch });
  if (writeResult && writeResult.matchedCount === 0) {
    throw lifecycleError(
      `Material ${String(materialId)} changed state while transitioning ${currentState} to ${nextState}`,
      LIFECYCLE_ERROR_CODES.CONCURRENT_MODIFICATION
    );
  }

  // Add audit events or logs for state changes that affect users or funds
  auditLog({
    event: 'material_lifecycle_transition',
    materialId: String(materialId),
    actor: String(actor),
    from: currentState,
    to: nextState,
    reason,
    ...eventDetails
  });

  return { ...material, ...patch };
}

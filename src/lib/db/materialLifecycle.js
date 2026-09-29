import { auditLog } from '@/lib/api/audit';

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

export function isValidTransition(currentState, nextState) {
  if (currentState === nextState) return true;
  const allowed = VALID_TRANSITIONS[currentState || MaterialLifecycleState.DRAFT];
  return allowed ? allowed.includes(nextState) : false;
}

export async function transitionMaterialState(db, materialId, nextState, { actor, reason, eventDetails = {} } = {}) {
  const materials = db.collection('materials');
  const material = await materials.findOne({ _id: materialId });
  if (!material) {
    throw new Error('Material not found');
  }

  const currentState = material.lifecycleState || MaterialLifecycleState.DRAFT;
  if (!isValidTransition(currentState, nextState)) {
    throw new Error(`Invalid lifecycle transition from ${currentState} to ${nextState}`);
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

  await materials.updateOne({ _id: materialId }, { $set: patch });

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

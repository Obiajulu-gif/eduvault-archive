/**
 * src/lib/auth/permissionDiff.js
 *
 * Permission Diff Engine for Role and Policy Changes.
 * Generates an impact report before roles or policies are altered,
 * evaluating privilege elevation, revoked capabilities, risk levels,
 * and operational safety guards.
 */

export const ROLE_PERMISSIONS = Object.freeze({
  admin: Object.freeze([
    'audit:read',
    'export:full',
    'export:pii',
    'materials:delete',
    'materials:moderate',
    'materials:publish',
    'materials:read',
    'materials:write',
    'policies:read',
    'policies:write',
    'purchases:read',
    'refunds:process',
    'refunds:read',
    'system:configure',
    'system:migrate',
    'users:manage_roles',
    'users:read',
    'users:suspend',
    'users:write',
  ]),
  creator: Object.freeze([
    'analytics:read_own',
    'export:own',
    'materials:create',
    'materials:delete_own',
    'materials:publish_own',
    'materials:read',
    'materials:write_own',
    'payouts:request',
    'sales:read_own',
  ]),
  learner: Object.freeze([
    'export:own_library',
    'materials:download_purchased',
    'materials:purchase',
    'materials:read_public',
    'progress:write_own',
    'refunds:request_own',
  ]),
  user: Object.freeze([
    'materials:read_public',
    'profile:read_own',
    'profile:write_own',
  ]),
});

export const VALID_ROLES = Object.freeze(Object.keys(ROLE_PERMISSIONS));

export const RiskLevel = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

export const CRITICAL_PERMISSIONS = Object.freeze([
  'users:manage_roles',
  'system:configure',
  'system:migrate',
  'users:suspend',
  'policies:write',
]);

export const HIGH_RISK_PERMISSIONS = Object.freeze([
  'materials:moderate',
  'refunds:process',
  'materials:delete',
  'export:pii',
  'export:full',
]);

export const MEDIUM_RISK_PERMISSIONS = Object.freeze([
  'materials:publish',
  'materials:create',
  'materials:publish_own',
  'payouts:request',
  'users:write',
]);

/**
 * Returns the standard permissions array for a given role.
 * @param {string} role
 * @returns {string[]}
 */
export function getPermissionsForRole(role) {
  if (!role || typeof role !== 'string') return [];
  const normalized = role.toLowerCase().trim();
  const perms = ROLE_PERMISSIONS[normalized];
  return perms ? [...perms] : [];
}

/**
 * Resolves all effective permissions for a user taking into account
 * role-based defaults, custom user grants, and explicit revocations.
 *
 * @param {object} user
 * @returns {string[]}
 */
export function getEffectivePermissions(user) {
  if (!user || typeof user !== 'object') return [];
  const base = new Set(getPermissionsForRole(user.role));
  
  if (Array.isArray(user.customPermissions)) {
    for (const p of user.customPermissions) {
      if (typeof p === 'string' && p.trim()) base.add(p.trim());
    }
  }

  if (Array.isArray(user.revokedPermissions)) {
    for (const p of user.revokedPermissions) {
      base.delete(p.trim());
    }
  }

  return Array.from(base).sort();
}

/**
 * Evaluates the risk level for a list of added permissions and target role.
 *
 * @param {string[]} addedPermissions
 * @param {string} targetRole
 * @returns {string} One of RiskLevel
 */
export function evaluateRiskLevel(addedPermissions = [], targetRole = '') {
  if (targetRole === 'admin') return RiskLevel.CRITICAL;

  const addedSet = new Set(addedPermissions);

  for (const crit of CRITICAL_PERMISSIONS) {
    if (addedSet.has(crit)) return RiskLevel.CRITICAL;
  }

  for (const high of HIGH_RISK_PERMISSIONS) {
    if (addedSet.has(high)) return RiskLevel.HIGH;
  }

  for (const med of MEDIUM_RISK_PERMISSIONS) {
    if (addedSet.has(med)) return RiskLevel.MEDIUM;
  }

  return RiskLevel.LOW;
}

/**
 * Generates breaking change warnings when a role transition removes capabilities.
 *
 * @param {string} currentRole
 * @param {string} targetRole
 * @param {string[]} removedPermissions
 * @returns {string[]}
 */
export function detectBreakingChanges(currentRole, targetRole, removedPermissions = []) {
  const warnings = [];
  const removed = new Set(removedPermissions);

  if (currentRole === 'creator' && targetRole !== 'creator') {
    if (removed.has('materials:write_own')) {
      warnings.push('User is losing creator edit permissions. Existing drafts and published materials will become read-only.');
    }
    if (removed.has('payouts:request')) {
      warnings.push('User is losing payout request capability. Any pending creator balance must be handled by an administrator.');
    }
  }

  if (currentRole === 'admin' && targetRole !== 'admin') {
    warnings.push('User is being demoted from admin. All administrative console and audit log access will be revoked immediately.');
  }

  return warnings;
}

/**
 * Computes a permission diff report before applying a role or policy change.
 *
 * @param {object} opts
 * @param {string} opts.currentRole
 * @param {string} opts.targetRole
 * @param {string[]} [opts.currentPermissions]
 * @param {string[]} [opts.targetPermissions]
 * @param {string} [opts.actor]
 * @param {string} [opts.targetUserId]
 * @param {string} [opts.reason]
 * @returns {object} PermissionDiffReport
 */
export function computePermissionDiff({
  currentRole,
  targetRole,
  currentPermissions,
  targetPermissions,
  actor = null,
  targetUserId = null,
  reason = null,
}) {
  if (!targetRole || typeof targetRole !== 'string') {
    throw new Error('computePermissionDiff: targetRole is required');
  }

  const normalizedCurrent = (currentRole || 'user').toLowerCase().trim();
  const normalizedTarget = targetRole.toLowerCase().trim();

  if (!VALID_ROLES.includes(normalizedTarget)) {
    throw new Error(`computePermissionDiff: targetRole "${targetRole}" is not a valid role`);
  }

  const currentSet = new Set(
    Array.isArray(currentPermissions)
      ? currentPermissions
      : getPermissionsForRole(normalizedCurrent)
  );

  const targetSet = new Set(
    Array.isArray(targetPermissions)
      ? targetPermissions
      : getPermissionsForRole(normalizedTarget)
  );

  const added = [];
  const removed = [];
  const retained = [];

  for (const perm of targetSet) {
    if (currentSet.has(perm)) {
      retained.push(perm);
    } else {
      added.push(perm);
    }
  }

  for (const perm of currentSet) {
    if (!targetSet.has(perm)) {
      removed.push(perm);
    }
  }

  added.sort();
  removed.sort();
  retained.sort();

  const isElevation = normalizedTarget === 'admin' || (normalizedCurrent !== 'admin' && added.length > 0 && removed.length === 0);
  const isDemotion = normalizedCurrent === 'admin' && normalizedTarget !== 'admin';
  const riskLevel = evaluateRiskLevel(added, normalizedTarget);
  const criticalPermissionsAdded = added.filter(p => CRITICAL_PERMISSIONS.includes(p));
  const breakingChanges = detectBreakingChanges(normalizedCurrent, normalizedTarget, removed);

  const requiresElevationConfirmation = riskLevel === RiskLevel.CRITICAL || isElevation;

  const summary = `Role change ${normalizedCurrent} -> ${normalizedTarget}: +${added.length} added, -${removed.length} removed, ${retained.length} retained. Risk level: ${riskLevel}.`;

  return {
    valid: true,
    currentRole: normalizedCurrent,
    targetRole: normalizedTarget,
    targetUserId,
    actor,
    reason,
    addedPermissions: added,
    removedPermissions: removed,
    retainedPermissions: retained,
    isElevation,
    isDemotion,
    riskLevel,
    criticalPermissionsAdded,
    requiresElevationConfirmation,
    breakingChanges,
    summary,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Validates a requested role transition and enforces security invariants.
 *
 * @param {object} opts
 * @param {object} opts.adminActor - The admin requesting the change
 * @param {object} opts.targetUser - The user receiving the change
 * @param {string} opts.newRole    - Desired new role
 * @param {boolean} [opts.confirmElevatedRisk] - Explicit confirmation flag for critical elevations
 * @returns {{ allowed: boolean, error?: string, status?: number, diffReport: object }}
 */
export function validateRoleTransition({
  adminActor,
  targetUser,
  newRole,
  confirmElevatedRisk = false,
}) {
  if (!adminActor || adminActor.role !== 'admin') {
    return {
      allowed: false,
      error: 'Unauthorized. Admin access required.',
      status: 403,
      diffReport: null,
    };
  }

  if (!targetUser || !targetUser._id) {
    return {
      allowed: false,
      error: 'Target user not found.',
      status: 404,
      diffReport: null,
    };
  }

  if (!newRole || !VALID_ROLES.includes(newRole.toLowerCase().trim())) {
    return {
      allowed: false,
      error: `Invalid role "${newRole}". Allowed roles: ${VALID_ROLES.join(', ')}`,
      status: 400,
      diffReport: null,
    };
  }

  const currentRole = targetUser.role || 'user';
  if (currentRole === newRole) {
    return {
      allowed: false,
      error: 'User already has this role.',
      status: 409,
      diffReport: null,
    };
  }

  // Self-demotion guard: an admin cannot demote themselves to prevent lockout
  const actorId = String(adminActor.sub || adminActor._id || '');
  const targetId = String(targetUser._id);
  if (actorId && actorId === targetId && currentRole === 'admin' && newRole !== 'admin') {
    return {
      allowed: false,
      error: 'Self-demotion protection: an administrator cannot revoke their own admin role.',
      status: 422,
      diffReport: null,
    };
  }

  const diffReport = computePermissionDiff({
    currentRole,
    targetRole: newRole,
    actor: adminActor.walletAddress || adminActor.sub || 'admin',
    targetUserId: targetId,
  });

  // Guard: If risk level is critical, require explicit confirmation flag
  if (diffReport.riskLevel === RiskLevel.CRITICAL && !confirmElevatedRisk) {
    return {
      allowed: false,
      error: 'Critical privilege elevation detected. Role change requires explicit confirmElevatedRisk: true confirmation.',
      status: 428, // Precondition Required
      diffReport,
    };
  }

  return {
    allowed: true,
    diffReport,
  };
}

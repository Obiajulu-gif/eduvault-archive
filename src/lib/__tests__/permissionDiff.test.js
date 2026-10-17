import { describe, expect, it } from 'vitest';
import {
  ROLE_PERMISSIONS,
  RiskLevel,
  getPermissionsForRole,
  getEffectivePermissions,
  evaluateRiskLevel,
  detectBreakingChanges,
  computePermissionDiff,
  validateRoleTransition,
} from '../auth/permissionDiff.js';

describe('Permission Diff Engine (Issue #1011)', () => {
  it('identifies standard roles and default permissions', () => {
    const admin = getPermissionsForRole('admin');
    expect(admin).toContain('users:manage_roles');
    expect(admin).toContain('export:pii');

    const creator = getPermissionsForRole('creator');
    expect(creator).toContain('materials:create');
    expect(creator).not.toContain('users:manage_roles');
  });

  it('computes effective permissions including custom grants and revocations', () => {
    const effective = getEffectivePermissions({
      role: 'learner',
      customPermissions: ['materials:create'],
      revokedPermissions: ['materials:purchase'],
    });
    expect(effective).toContain('materials:create');
    expect(effective).not.toContain('materials:purchase');
    expect(effective).toContain('export:own_library');
  });

  it('computes accurate diff between learner and creator', () => {
    const diff = computePermissionDiff({
      currentRole: 'learner',
      targetRole: 'creator',
      actor: 'admin-1',
      targetUserId: 'user-1',
    });
    expect(diff.valid).toBe(true);
    expect(diff.addedPermissions).toContain('materials:create');
    expect(diff.removedPermissions).toContain('materials:purchase');
    expect(diff.riskLevel).toBe(RiskLevel.MEDIUM);
  });

  it('marks elevation to admin as critical risk and requires confirmation', () => {
    const diff = computePermissionDiff({
      currentRole: 'creator',
      targetRole: 'admin',
    });
    expect(diff.isElevation).toBe(true);
    expect(diff.riskLevel).toBe(RiskLevel.CRITICAL);
    expect(diff.requiresElevationConfirmation).toBe(true);
  });

  it('enforces transition guards and self-demotion lockout', () => {
    const lockout = validateRoleTransition({
      adminActor: { sub: 'admin-1', role: 'admin' },
      targetUser: { _id: 'admin-1', role: 'admin' },
      newRole: 'learner',
    });
    expect(lockout.allowed).toBe(false);
    expect(lockout.status).toBe(422);

    const elevate = validateRoleTransition({
      adminActor: { sub: 'admin-1', role: 'admin' },
      targetUser: { _id: 'target-1', role: 'learner' },
      newRole: 'admin',
      confirmElevatedRisk: false,
    });
    expect(elevate.allowed).toBe(false);
    expect(elevate.status).toBe(428);

    const elevateConfirmed = validateRoleTransition({
      adminActor: { sub: 'admin-1', role: 'admin' },
      targetUser: { _id: 'target-1', role: 'learner' },
      newRole: 'admin',
      confirmElevatedRisk: true,
    });
    expect(elevateConfirmed.allowed).toBe(true);
  });
});

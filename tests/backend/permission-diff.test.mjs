import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  ROLE_PERMISSIONS,
  VALID_ROLES,
  RiskLevel,
  getPermissionsForRole,
  getEffectivePermissions,
  evaluateRiskLevel,
  detectBreakingChanges,
  computePermissionDiff,
  validateRoleTransition,
} from '../../src/lib/auth/permissionDiff.js';

describe('Permission Diff Engine (Issue #1011)', () => {
  describe('Role & Permission Discovery', () => {
    test('returns correct default permissions for known roles', () => {
      const adminPerms = getPermissionsForRole('admin');
      assert.ok(adminPerms.includes('users:manage_roles'));
      assert.ok(adminPerms.includes('materials:publish'));
      assert.ok(adminPerms.includes('export:pii'));

      const creatorPerms = getPermissionsForRole('creator');
      assert.ok(creatorPerms.includes('materials:create'));
      assert.ok(creatorPerms.includes('payouts:request'));
      assert.ok(!creatorPerms.includes('users:manage_roles'));

      const learnerPerms = getPermissionsForRole('learner');
      assert.ok(learnerPerms.includes('materials:purchase'));
      assert.ok(!learnerPerms.includes('materials:create'));

      const userPerms = getPermissionsForRole('user');
      assert.ok(userPerms.includes('profile:read_own'));
    });

    test('returns empty array for invalid or unknown roles', () => {
      assert.deepEqual(getPermissionsForRole(null), []);
      assert.deepEqual(getPermissionsForRole(''), []);
      assert.deepEqual(getPermissionsForRole('superman'), []);
    });

    test('computes effective permissions with custom grants and revocations', () => {
      const user = {
        role: 'learner',
        customPermissions: ['materials:create', 'custom:flag'],
        revokedPermissions: ['refunds:request_own'],
      };
      const effective = getEffectivePermissions(user);
      assert.ok(effective.includes('materials:create'));
      assert.ok(effective.includes('custom:flag'));
      assert.ok(!effective.includes('refunds:request_own'));
      assert.ok(effective.includes('materials:purchase'));
    });
  });

  describe('Risk Level & Elevation Evaluation', () => {
    test('marks elevation to admin as CRITICAL', () => {
      const risk = evaluateRiskLevel(['users:manage_roles'], 'admin');
      assert.equal(risk, RiskLevel.CRITICAL);
    });

    test('marks elevation with critical permissions as CRITICAL even if non-admin', () => {
      const risk = evaluateRiskLevel(['system:configure'], 'creator');
      assert.equal(risk, RiskLevel.CRITICAL);
    });

    test('marks moderation and refund processing as HIGH', () => {
      const risk = evaluateRiskLevel(['materials:moderate'], 'creator');
      assert.equal(risk, RiskLevel.HIGH);
    });

    test('marks publishing and payouts as MEDIUM', () => {
      const risk = evaluateRiskLevel(['materials:publish_own'], 'creator');
      assert.equal(risk, RiskLevel.MEDIUM);
    });

    test('marks learner and user permissions as LOW', () => {
      const risk = evaluateRiskLevel(['profile:read_own'], 'user');
      assert.equal(risk, RiskLevel.LOW);
    });
  });

  describe('Breaking Changes Detection', () => {
    test('warns when creator is demoted to learner/user and loses write capabilities', () => {
      const warnings = detectBreakingChanges('creator', 'learner', ['materials:write_own', 'payouts:request']);
      assert.equal(warnings.length, 2);
      assert.ok(warnings[0].includes('losing creator edit permissions'));
      assert.ok(warnings[1].includes('losing payout request capability'));
    });

    test('warns when admin is demoted', () => {
      const warnings = detectBreakingChanges('admin', 'creator', ['users:manage_roles']);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes('demoted from admin'));
    });

    test('produces no warnings for safe promotions', () => {
      const warnings = detectBreakingChanges('learner', 'creator', []);
      assert.equal(warnings.length, 0);
    });
  });

  describe('computePermissionDiff', () => {
    test('computes complete diff report from learner to creator', () => {
      const diff = computePermissionDiff({
        currentRole: 'learner',
        targetRole: 'creator',
        actor: 'admin-wallet-123',
        targetUserId: 'user-456',
        reason: 'Upgrading verified instructor',
      });

      assert.equal(diff.valid, true);
      assert.equal(diff.currentRole, 'learner');
      assert.equal(diff.targetRole, 'creator');
      assert.ok(diff.addedPermissions.includes('materials:create'));
      assert.ok(diff.addedPermissions.includes('payouts:request'));
      assert.ok(diff.removedPermissions.includes('materials:purchase'));
      assert.equal(diff.isElevation, false);
      assert.equal(diff.isDemotion, false);
      assert.equal(diff.riskLevel, RiskLevel.MEDIUM);
      assert.ok(diff.summary.includes('learner -> creator'));
    });

    test('computes elevation from creator to admin with critical risk', () => {
      const diff = computePermissionDiff({
        currentRole: 'creator',
        targetRole: 'admin',
        actor: 'super-admin',
        targetUserId: 'user-789',
      });

      assert.equal(diff.isElevation, true);
      assert.equal(diff.riskLevel, RiskLevel.CRITICAL);
      assert.ok(diff.criticalPermissionsAdded.length > 0);
      assert.ok(diff.criticalPermissionsAdded.includes('users:manage_roles'));
      assert.equal(diff.requiresElevationConfirmation, true);
    });

    test('rejects missing or invalid targetRole', () => {
      assert.throws(() => {
        computePermissionDiff({ currentRole: 'user', targetRole: '' });
      }, /targetRole is required/);

      assert.throws(() => {
        computePermissionDiff({ currentRole: 'user', targetRole: 'hacker_role' });
      }, /not a valid role/);
    });
  });

  describe('validateRoleTransition', () => {
    const adminActor = { sub: 'admin-1', role: 'admin', walletAddress: '0xAdmin' };
    const nonAdmin = { sub: 'user-1', role: 'user', walletAddress: '0xUser' };

    test('blocks non-admin actor from changing roles', () => {
      const result = validateRoleTransition({
        adminActor: nonAdmin,
        targetUser: { _id: 'target-1', role: 'user' },
        newRole: 'creator',
      });
      assert.equal(result.allowed, false);
      assert.equal(result.status, 403);
    });

    test('blocks missing target user', () => {
      const result = validateRoleTransition({
        adminActor,
        targetUser: null,
        newRole: 'creator',
      });
      assert.equal(result.allowed, false);
      assert.equal(result.status, 404);
    });

    test('blocks setting identical role (409 Conflict)', () => {
      const result = validateRoleTransition({
        adminActor,
        targetUser: { _id: 'target-1', role: 'creator' },
        newRole: 'creator',
      });
      assert.equal(result.allowed, false);
      assert.equal(result.status, 409);
    });

    test('prevents admin self-demotion lockout (422)', () => {
      const result = validateRoleTransition({
        adminActor: { sub: 'admin-1', role: 'admin' },
        targetUser: { _id: 'admin-1', role: 'admin' },
        newRole: 'learner',
      });
      assert.equal(result.allowed, false);
      assert.equal(result.status, 422);
      assert.ok(result.error.includes('Self-demotion protection'));
    });

    test('requires confirmElevatedRisk: true for critical elevations (428)', () => {
      const result = validateRoleTransition({
        adminActor,
        targetUser: { _id: 'target-2', role: 'learner' },
        newRole: 'admin',
        confirmElevatedRisk: false,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.status, 428);
      assert.ok(result.error.includes('confirmElevatedRisk'));
      assert.ok(result.diffReport !== null);
    });

    test('allows critical elevation when confirmElevatedRisk is true', () => {
      const result = validateRoleTransition({
        adminActor,
        targetUser: { _id: 'target-2', role: 'learner' },
        newRole: 'admin',
        confirmElevatedRisk: true,
      });
      assert.equal(result.allowed, true);
      assert.ok(result.diffReport);
      assert.equal(result.diffReport.riskLevel, RiskLevel.CRITICAL);
    });

    test('allows standard safe transition without extra flags', () => {
      const result = validateRoleTransition({
        adminActor,
        targetUser: { _id: 'target-3', role: 'user' },
        newRole: 'learner',
      });
      assert.equal(result.allowed, true);
      assert.ok(result.diffReport);
    });
  });
});

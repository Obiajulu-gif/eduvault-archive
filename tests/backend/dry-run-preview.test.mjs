/**
 * tests/backend/dry-run-preview.test.mjs
 *
 * Automated tests for the dry-run preview of destructive maintainer actions
 * (issue #1095). Covers normal, failure, authorization, fingerprint, and
 * rollback-documentation paths.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DESTRUCTIVE_ACTION,
  previewDestructiveAction,
  assertPreviewFingerprintValid,
  DryRunAuthError,
  DryRunValidationError,
  DryRunFingerprintMismatchError,
} from '../../src/lib/admin/dryRunPreview.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

const adminPrincipal = { id: 'admin-1', role: 'admin' };
const allowAll = async () => true;
const denyAll = async () => false;

// ─── Normal path ──────────────────────────────────────────────────────────

describe('dry-run preview — normal path (#1095)', () => {
  it('returns dryRun:true with no mutations for BULK_CONTENT_REMOVE', async () => {
    const preview = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.BULK_CONTENT_REMOVE,
      params: { materialIds: ['m1', 'm2', 'm3'] },
      authorize: allowAll,
    });

    assert.equal(preview.dryRun, true);
    assert.equal(preview.actionType, DESTRUCTIVE_ACTION.BULK_CONTENT_REMOVE);
    assert.equal(preview.affectedCount, 3);
    assert.ok(preview.fingerprint, 'fingerprint should be present');
    assert.ok(preview.generatedAt, 'generatedAt should be present');
    assert.ok(Array.isArray(preview.plan));
    assert.equal(preview.plan.length, 3);
  });

  it('every plan item documents action, collection, sideEffects and rollback', async () => {
    const preview = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.BULK_CONTENT_REMOVE,
      params: { materialIds: ['m1'] },
      authorize: allowAll,
    });

    const item = preview.plan[0];
    assert.ok(item.id, 'plan item must have id');
    assert.ok(item.collection, 'plan item must have collection');
    assert.ok(item.action, 'plan item must have action');
    assert.ok(Array.isArray(item.sideEffects), 'plan item must list sideEffects');
    assert.ok(item.rollback, 'plan item must describe rollback');
  });

  it('returns dryRun:true for BULK_ENTITLEMENT_REVOKE', async () => {
    const preview = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.BULK_ENTITLEMENT_REVOKE,
      params: { entitlementIds: ['e1', 'e2'], reason: 'fraud detected' },
      authorize: allowAll,
    });

    assert.equal(preview.dryRun, true);
    assert.equal(preview.affectedCount, 2);
    assert.equal(preview.plan[0].collection, 'entitlements');
    assert.equal(preview.plan[0].action, 'revoke');
    assert.ok(preview.plan[0].fields?.status?.from === 'active');
    assert.ok(preview.plan[0].fields?.status?.to === 'revoked');
  });

  it('returns dryRun:true for USER_SUSPENSION', async () => {
    const preview = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.USER_SUSPENSION,
      params: { userIds: ['u1'], reason: 'TOS violation' },
      authorize: allowAll,
    });

    assert.equal(preview.dryRun, true);
    assert.equal(preview.plan[0].action, 'suspend');
    assert.equal(preview.plan[0].collection, 'users');
  });

  it('returns dryRun:true for DATA_PURGE', async () => {
    const preview = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.DATA_PURGE,
      params: { targetCollection: 'stale_sessions', filter: { createdAt: { $lt: '2024-01-01' } } },
      authorize: allowAll,
    });

    assert.equal(preview.dryRun, true);
    assert.ok(preview.plan.length >= 1);
    assert.equal(preview.plan[0].action, 'purge');
  });

  it('returns dryRun:true for MATERIAL_UNPUBLISH', async () => {
    const preview = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.MATERIAL_UNPUBLISH,
      params: { materialIds: ['m1', 'm2'] },
      authorize: allowAll,
    });

    assert.equal(preview.affectedCount, 2);
    assert.equal(preview.plan[0].action, 'unpublish');
  });

  it('returns dryRun:true for CREATOR_DEACTIVATION', async () => {
    const preview = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.CREATOR_DEACTIVATION,
      params: { creatorIds: ['c1'], reason: 'copyright dispute' },
      authorize: allowAll,
    });

    assert.equal(preview.plan[0].action, 'deactivate');
    assert.equal(preview.plan[0].collection, 'users');
  });

  it('returns affectedCount=0 and risk.level=none for empty params', async () => {
    const preview = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.BULK_CONTENT_REMOVE,
      params: { materialIds: [] },
      authorize: allowAll,
    });

    assert.equal(preview.affectedCount, 0);
    assert.equal(preview.risk.level, 'none');
  });
});

// ─── Risk scoring ─────────────────────────────────────────────────────────

describe('dry-run preview — risk levels (#1095)', () => {
  it('scores DATA_PURGE as critical', async () => {
    const preview = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.DATA_PURGE,
      params: { targetCollection: 'old_data' },
      authorize: allowAll,
    });
    assert.equal(preview.risk.level, 'critical');
  });

  it('scores BULK_ENTITLEMENT_REVOKE as high', async () => {
    const preview = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.BULK_ENTITLEMENT_REVOKE,
      params: { entitlementIds: ['e1', 'e2'] },
      authorize: allowAll,
    });
    assert.equal(preview.risk.level, 'high');
  });

  it('scores USER_SUSPENSION as high', async () => {
    const preview = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.USER_SUSPENSION,
      params: { userIds: ['u1', 'u2'] },
      authorize: allowAll,
    });
    assert.equal(preview.risk.level, 'high');
  });
});

// ─── Determinism / fingerprint ────────────────────────────────────────────

describe('dry-run preview — fingerprint (#1095)', () => {
  it('two calls with identical params produce identical fingerprints', async () => {
    const opts = {
      actionType: DESTRUCTIVE_ACTION.BULK_CONTENT_REMOVE,
      params: { materialIds: ['m1', 'm2'] },
      authorize: allowAll,
    };

    const a = await previewDestructiveAction(opts);
    const b = await previewDestructiveAction(opts);

    assert.equal(a.fingerprint, b.fingerprint);
  });

  it('different materialIds produce different fingerprints', async () => {
    const a = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.BULK_CONTENT_REMOVE,
      params: { materialIds: ['m1'] },
      authorize: allowAll,
    });
    const b = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.BULK_CONTENT_REMOVE,
      params: { materialIds: ['m2'] },
      authorize: allowAll,
    });

    assert.notEqual(a.fingerprint, b.fingerprint);
  });

  it('assertPreviewFingerprintValid resolves when fingerprints match', async () => {
    const preview = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.MATERIAL_UNPUBLISH,
      params: { materialIds: ['m1'] },
      authorize: allowAll,
    });

    // Should not throw
    await assertPreviewFingerprintValid(
      preview.fingerprint,
      DESTRUCTIVE_ACTION.MATERIAL_UNPUBLISH,
      { materialIds: ['m1'] },
      null,
    );
  });

  it('assertPreviewFingerprintValid throws DryRunFingerprintMismatchError when params drift', async () => {
    const preview = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.MATERIAL_UNPUBLISH,
      params: { materialIds: ['m1', 'm2'] },
      authorize: allowAll,
    });

    await assert.rejects(
      () =>
        assertPreviewFingerprintValid(
          preview.fingerprint,
          DESTRUCTIVE_ACTION.MATERIAL_UNPUBLISH,
          { materialIds: ['m1'] }, // drifted: one item removed
          null,
        ),
      (err) => err instanceof DryRunFingerprintMismatchError && err.code === 'DRYRUN_FINGERPRINT_MISMATCH',
    );
  });
});

// ─── Authorization path ───────────────────────────────────────────────────

describe('dry-run preview — authorization (#1095)', () => {
  it('throws DryRunAuthError when authorize returns false', async () => {
    await assert.rejects(
      () =>
        previewDestructiveAction({
          actionType: DESTRUCTIVE_ACTION.USER_SUSPENSION,
          params: { userIds: ['u1'] },
          authorize: denyAll,
        }),
      (err) => err instanceof DryRunAuthError && err.status === 403,
    );
  });

  it('throws DryRunAuthError when authorize throws', async () => {
    await assert.rejects(
      () =>
        previewDestructiveAction({
          actionType: DESTRUCTIVE_ACTION.USER_SUSPENSION,
          params: { userIds: ['u1'] },
          authorize: async () => { throw new Error('auth service unavailable'); },
        }),
      (err) => err instanceof DryRunAuthError,
    );
  });

  it('runs normally for an authorized admin', async () => {
    const preview = await previewDestructiveAction({
      actionType: DESTRUCTIVE_ACTION.USER_SUSPENSION,
      params: { userIds: ['u1'] },
      principal: adminPrincipal,
      authorize: async (p) => p?.role === 'admin',
    });

    assert.equal(preview.dryRun, true);
  });
});

// ─── Validation path ──────────────────────────────────────────────────────

describe('dry-run preview — validation (#1095)', () => {
  it('throws DryRunValidationError for an unknown actionType', async () => {
    await assert.rejects(
      () =>
        previewDestructiveAction({
          actionType: 'UNKNOWN_ACTION',
          params: {},
          authorize: allowAll,
        }),
      (err) => err instanceof DryRunValidationError && err.status === 400,
    );
  });

  it('throws DryRunValidationError when actionType is omitted', async () => {
    await assert.rejects(
      () =>
        previewDestructiveAction({
          actionType: undefined,
          params: {},
          authorize: allowAll,
        }),
      (err) => err instanceof DryRunValidationError,
    );
  });
});

// ─── Rollback documentation ───────────────────────────────────────────────

describe('dry-run preview — rollback documentation (#1095)', () => {
  it('every plan item contains a non-empty rollback description', async () => {
    for (const actionType of Object.values(DESTRUCTIVE_ACTION)) {
      let params = {};
      if (actionType === DESTRUCTIVE_ACTION.BULK_CONTENT_REMOVE) params = { materialIds: ['m1'] };
      else if (actionType === DESTRUCTIVE_ACTION.BULK_ENTITLEMENT_REVOKE) params = { entitlementIds: ['e1'] };
      else if (actionType === DESTRUCTIVE_ACTION.USER_SUSPENSION) params = { userIds: ['u1'] };
      else if (actionType === DESTRUCTIVE_ACTION.DATA_PURGE) params = { targetCollection: 'test' };
      else if (actionType === DESTRUCTIVE_ACTION.MATERIAL_UNPUBLISH) params = { materialIds: ['m1'] };
      else if (actionType === DESTRUCTIVE_ACTION.CREATOR_DEACTIVATION) params = { creatorIds: ['c1'] };

      const preview = await previewDestructiveAction({ actionType, params, authorize: allowAll });

      for (const item of preview.plan) {
        assert.ok(
          typeof item.rollback === 'string' && item.rollback.length > 0,
          `${actionType} plan item ${item.id} is missing rollback description`,
        );
      }
    }
  });
});

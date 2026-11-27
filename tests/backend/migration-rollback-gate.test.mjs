/**
 * Release readiness checks for migrations and rollback (#1080).
 * Covers the normal, failure, retry, and authorization paths.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  ROLLBACK_STRATEGY,
  evaluateMigrationRollbackGate,
  loadUnresolvedRuns,
} from '../../src/lib/release/migrationRollbackGate.js';

const NOW = new Date('2026-10-14T12:00:00Z');
const COMMIT = 'a'.repeat(40);
const DEPLOYER = { id: 'deployer-carol', role: 'deployer' };

function downMigration(overrides = {}) {
  return {
    id: 'creator_profile_wallet_schema_v2',
    order: 1,
    author: 'maintainer-alice',
    idempotent: true,
    dryRun: { status: 'passed', at: '2026-10-14T09:00:00Z', attempts: 1, commit: COMMIT },
    rollback: {
      strategy: ROLLBACK_STRATEGY.DOWN,
      script: 'scripts/migrations/migrate-creator-profiles.mjs --rollback',
      rehearsalStatus: 'passed',
      rehearsedAt: '2026-10-13T16:00:00Z',
    },
    ...overrides,
  };
}

const evaluate = (migrations, options = {}) =>
  evaluateMigrationRollbackGate({ release: 'v0.2.0', migrations }, { actor: DEPLOYER, now: NOW, expectedCommit: COMMIT, ...options });

const messages = (report) => report.blockers.map((b) => b.message).join('\n');

describe('normal path', () => {
  test('a rehearsed down migration is ready', () => {
    const report = evaluate([downMigration()]);
    assert.equal(report.ready, true, messages(report));
    assert.deepEqual(report.checked, ['creator_profile_wallet_schema_v2']);
  });

  test('a release with no migrations is ready', () => {
    assert.equal(evaluate([]).ready, true);
  });

  test('a fresh, verified snapshot is an accepted rollback', () => {
    const report = evaluate([
      downMigration({
        rollback: {
          strategy: ROLLBACK_STRATEGY.RESTORE_SNAPSHOT,
          snapshotId: 'snap-1',
          snapshotAt: '2026-10-14T08:00:00Z',
          snapshotVerified: true,
        },
      }),
    ]);
    assert.equal(report.ready, true, messages(report));
  });

  test('the shipped example plan passes on its own dates', () => {
    const plan = JSON.parse(readFileSync(new URL('../../release/migration-plan.example.json', import.meta.url), 'utf8'));
    const report = evaluateMigrationRollbackGate(plan, { actor: DEPLOYER, now: NOW });
    assert.equal(report.ready, true, messages(report));
  });
});

describe('failure paths', () => {
  test('a missing or malformed plan blocks', () => {
    assert.equal(evaluateMigrationRollbackGate(null, { actor: DEPLOYER }).ready, false);
    assert.equal(evaluateMigrationRollbackGate({ migrations: 'x' }, { actor: DEPLOYER }).ready, false);
  });

  test('duplicate ids and out-of-order migrations block', () => {
    const report = evaluate([downMigration(), downMigration({ order: 1 })]);
    assert.equal(report.ready, false);
    assert.match(messages(report), /duplicate migration id/);
    assert.match(messages(report), /order must be a number greater/);
  });

  test('failed, stale, future or wrong-commit dry runs block', () => {
    const cases = [
      [{ status: 'failed', at: '2026-10-14T09:00:00Z' }, /status "passed"/],
      [{ status: 'passed', at: '2026-09-01T00:00:00Z' }, /within the last 7 days/],
      [{ status: 'passed', at: '2026-10-15T00:00:00Z' }, /in the future/],
      [{ status: 'passed', at: '2026-10-14T09:00:00Z', commit: 'b'.repeat(40) }, /not the release commit/],
    ];
    for (const [dryRun, pattern] of cases) {
      const report = evaluate([downMigration({ dryRun })]);
      assert.equal(report.ready, false);
      assert.match(messages(report), pattern);
    }
  });

  test('missing strategy, unrehearsed down script and stale snapshot block', () => {
    assert.match(messages(evaluate([downMigration({ rollback: {} })])), /rollback.strategy must be one of/);
    assert.match(
      messages(evaluate([downMigration({ rollback: { strategy: 'down', rehearsalStatus: 'failed' } })])),
      /down script path[\s\S]*rehearsal must have status "passed"/
    );
    const stale = evaluate([
      downMigration({
        rollback: { strategy: 'restore_snapshot', snapshotId: 's', snapshotAt: '2026-10-12T00:00:00Z', snapshotVerified: false },
      }),
    ]);
    assert.match(messages(stale), /restore-verified/);
    assert.match(messages(stale), /within the last 24 hours/);
  });
});

describe('retry path', () => {
  test('a migration that needed retries must be idempotent', () => {
    const retried = { status: 'passed', at: '2026-10-14T09:00:00Z', attempts: 3 };
    const unsafe = evaluate([downMigration({ idempotent: false, dryRun: retried })]);
    assert.equal(unsafe.ready, false);
    assert.match(messages(unsafe), /3 attempts but the migration is not marked idempotent/);
    assert.equal(evaluate([downMigration({ dryRun: retried })]).ready, true);
  });

  test('an unresolved rollback verification run blocks the same migration only', () => {
    const report = evaluate([downMigration()], {
      unresolvedRuns: [
        { name: 'creator_profile_wallet_schema_v2', state: 'rollback_drift' },
        { name: 'some_other_migration', state: 'rollback_failed' },
      ],
    });
    assert.equal(report.blockers.length, 1);
    assert.match(report.blockers[0].message, /unresolved \(rollback_drift\)/);
  });

  test('fails closed when rollback runs cannot be read', async () => {
    const db = { collection: () => ({ find: () => ({ toArray: async () => { throw new Error('socket closed'); } }) }) };
    const loaded = await loadUnresolvedRuns(db);
    assert.equal(loaded.error, 'socket closed');
    const report = evaluate([downMigration()], { unresolvedRuns: loaded.runs, unresolvedRunsError: loaded.error });
    assert.equal(report.ready, false);
    assert.match(messages(report), /Could not read rollback_verifications/);
  });

  test('loads unresolved runs with the documented query', async () => {
    let query = null;
    const db = {
      collection: (name) => {
        assert.equal(name, 'rollback_verifications');
        return { find: (q) => { query = q; return { toArray: async () => [{ _id: 'r1', name: 'm', state: 'applying' }] }; } };
      },
    };
    const loaded = await loadUnresolvedRuns(db);
    assert.deepEqual(loaded.runs, [{ name: 'm', state: 'applying', runId: 'r1' }]);
    assert.ok(query.state.$in.includes('rollback_drift'));
    assert.deepEqual(await loadUnresolvedRuns(null), { runs: [], error: null });
  });
});

describe('authorization path', () => {
  test('an unauthorized actor cannot pass the gate', () => {
    const report = evaluate([downMigration()], { actor: { id: 'learner-dan', role: 'learner' } });
    assert.equal(report.ready, false);
    assert.equal(report.blockers[0].migration, '*');
    assert.equal(evaluate([], { actor: null }).ready, false);
  });

  test('irreversible migrations need a second authorized approver', () => {
    const irreversible = (approvals) => downMigration({ rollback: { strategy: ROLLBACK_STRATEGY.NONE }, approvals });

    assert.match(messages(evaluate([irreversible([])])), /irreversible migration/);
    // Approver lacks a release role.
    assert.equal(evaluate([irreversible([{ id: 'eve', role: 'creator' }])]).ready, false);
    // Author cannot approve their own irreversible change.
    assert.equal(evaluate([irreversible([{ id: 'maintainer-alice', role: 'admin' }])]).ready, false);
    // The requester running the gate cannot self-approve either.
    assert.equal(evaluate([irreversible([{ id: 'deployer-carol', role: 'deployer' }])]).ready, false);
    // A distinct release engineer approves.
    const ok = evaluate([irreversible([{ id: 'release-bob', role: 'release_engineer' }])]);
    assert.equal(ok.ready, true, messages(ok));
    // Permission-based approval also counts.
    assert.equal(evaluate([irreversible([{ id: 'ops-fay', role: 'service', permissions: ['system:release'] }])]).ready, true);
  });
});

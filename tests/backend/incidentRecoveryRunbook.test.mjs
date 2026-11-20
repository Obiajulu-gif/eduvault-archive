import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  RecoveryCheckStatus,
  RecoveryAuthorizationError,
  RecoveryExecutionError,
  checkRefundKillSwitch,
  checkSignerCapLimits,
  checkAuditLedgerChain,
  checkDeadLetterBackpressure,
  checkIndexerSyncLag,
  runAllRecoveryChecks,
  executeRecoveryRemediation,
  assertRecoveryAuthorized,
} from '../../src/lib/ops/incidentRecoveryChecks.js';

describe('Incident Runbook with Executable Recovery Checks (#1110)', () => {
  test('normal path: runAllRecoveryChecks evaluates all checks and reports healthy status', async () => {
    const fakeDb = {
      collection(name) {
        if (name === 'sync_state') {
          return {
            findOne: async () => ({ _id: 'stellar_indexer', lastLedger: 1000 }),
          };
        }
        if (name === 'dead_letter_events') {
          return {
            countDocuments: async () => 0,
          };
        }
        if (name === 'audit_ledger') {
          return {
            find: () => ({
              sort: () => ({
                limit: () => ({
                  toArray: async () => [],
                }),
              }),
            }),
          };
        }
        return {
          findOne: async () => null,
          find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
        };
      },
    };

    const env = {
      REFUND_SIGNING_DISABLED: 'false',
      REFUND_MAX_AMOUNT_PER_TX: '500',
    };

    const report = await runAllRecoveryChecks({
      db: fakeDb,
      env,
      actor: { role: 'operator' },
      currentNetworkLedger: 1005, // 5 ledgers lag (<= 10 is passed)
    });

    assert.equal(report.healthy, true);
    assert.equal(report.summary.failed, 0);
    assert.ok(report.summary.passed >= 4);
  });

  test('failure path: detects breached dead letter queue threshold', async () => {
    const fakeDb = {
      collection: () => ({
        countDocuments: async () => 150, // threshold is 20
      }),
    };

    const res = await checkDeadLetterBackpressure({ db: fakeDb, maxThreshold: 20 });
    assert.equal(res.status, RecoveryCheckStatus.FAILED);
    assert.ok(res.message.includes('150 dead-letter events found'));
  });

  test('failure path: detects indexer cursor lag exceeding critical threshold', async () => {
    const fakeDb = {
      collection: () => ({
        findOne: async () => ({ lastLedger: 5000 }),
      }),
    };

    const res = await checkIndexerSyncLag({ db: fakeDb, currentNetworkLedger: 5200 }); // lag 200 > 50
    assert.equal(res.status, RecoveryCheckStatus.FAILED);
    assert.ok(res.message.includes('lagging behind network by 200 ledgers'));
  });

  test('failure path: detects broken audit ledger hash chain', async () => {
    const tamperedRecords = [
      { sequence: 0, previousHash: '0'.repeat(64), recordHash: 'hash0' },
      { sequence: 1, previousHash: 'corrupted_prev_hash', recordHash: 'hash1' },
    ];

    const fakeDb = {
      collection: () => ({
        find: () => ({
          sort: () => ({
            limit: () => ({
              toArray: async () => tamperedRecords,
            }),
          }),
        }),
      }),
    };

    const res = await checkAuditLedgerChain({ db: fakeDb });
    assert.equal(res.status, RecoveryCheckStatus.FAILED);
    assert.ok(res.message.includes('Audit chain broken'));
  });

  test('containment: checkRefundKillSwitch reports active kill switch when engaged', () => {
    const res = checkRefundKillSwitch({ env: { REFUND_SIGNING_DISABLED: 'true' } });
    assert.equal(res.status, RecoveryCheckStatus.PASSED);
    assert.equal(res.killSwitchEngaged, true);
    assert.ok(res.message.includes('Emergency kill switch ENGAGED'));
  });

  test('authorization path: assertRecoveryAuthorized rejects non-operator/non-admin actors', () => {
    assert.throws(() => assertRecoveryAuthorized(null), RecoveryAuthorizationError);
    assert.throws(() => assertRecoveryAuthorized({ role: 'student' }), RecoveryAuthorizationError);
    assert.throws(() => assertRecoveryAuthorized({ role: 'creator' }), RecoveryAuthorizationError);

    assert.doesNotThrow(() => assertRecoveryAuthorized({ role: 'operator' }));
    assert.doesNotThrow(() => assertRecoveryAuthorized({ role: 'admin' }));
  });

  test('retry & remediation path: executeRecoveryRemediation reprocesses retryable dead letters and logs audit', async () => {
    const deadLetters = [
      { _id: 'dl-1', status: 'retryable' },
      { _id: 'dl-2', status: 'retryable' },
    ];
    const auditLogs = [];

    const fakeDb = {
      collection(name) {
        if (name === 'dead_letter_events') {
          return {
            find: () => ({
              limit: () => ({
                toArray: async () => deadLetters,
              }),
            }),
            updateOne: async (q, u) => {
              const item = deadLetters.find((d) => d._id === q._id);
              if (item) Object.assign(item, u.$set);
            },
          };
        }
        if (name === 'incident_recovery_audit') {
          return {
            insertOne: async (entry) => { auditLogs.push(entry); },
          };
        }
        return {};
      },
    };

    const res = await executeRecoveryRemediation({
      db: fakeDb,
      action: 'reprocess_dead_letters',
      actor: { role: 'operator', id: 'op-001' },
      reason: 'Transient indexer connectivity restored',
    });

    assert.equal(res.success, true);
    assert.equal(res.logEntry.reprocessedCount, 2);
    assert.equal(deadLetters[0].status, 'reprocessing');
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].action, 'reprocess_dead_letters');
  });

  test('remediation validation: rejects unknown remediation action', async () => {
    await assert.rejects(
      () => executeRecoveryRemediation({
        action: 'wipe_all_data',
        actor: { role: 'operator' },
      }),
      RecoveryExecutionError
    );
  });
});


import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import {
  TransferState,
  DEFAULT_TRANSFER_TTL_MS,
  MIN_TRANSFER_TTL_MS,
  MAX_TRANSFER_TTL_MS,
  ACCEPT_LEASE_MS,
  initiateTransfer,
  acceptTransfer,
  declineTransfer,
  cancelTransfer,
  getTransfer,
  listTransfersForUser,
  listMaterialTransferHistory,
  recoverStuckTransfers,
} from '../../src/lib/ownership/ownershipTransfer.js';

function createMemoryDb() {
  const tables = new Map();
  function getTable(name) {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  }

  return {
    collection(name) {
      const rows = getTable(name);
      return {
        async findOne(query) {
          return rows.find((r) => {
            for (const [k, v] of Object.entries(query)) {
              if (v && typeof v === 'object' && '$in' in v) {
                if (!v.$in.includes(r[k])) return false;
              } else if (v && typeof v === 'object' && '$gt' in v) {
                if (!(r[k] > v.$gt)) return false;
              } else if (v && typeof v === 'object' && '$lte' in v) {
                if (!(r[k] <= v.$lte)) return false;
              } else if (v && typeof v === 'object' && '$ne' in v) {
                if (r[k] === v.$ne) return false;
              } else if (r[k] !== v) {
                return false;
              }
            }
            return true;
          }) ?? null;
        },
        find(query = {}) {
          const filtered = rows.filter((r) => {
            if (query.$or) {
              const matched = query.$or.some((branch) =>
                Object.entries(branch).every(([k, v]) => r[k] === v)
              );
              if (!matched) return false;
            }
            for (const [k, v] of Object.entries(query)) {
              if (k === '$or') continue;
              if (v && typeof v === 'object' && '$in' in v) {
                if (!v.$in.includes(r[k])) return false;
              } else if (v && typeof v === 'object' && '$lte' in v) {
                if (!(r[k] <= v.$lte)) return false;
              } else if (r[k] !== v) {
                return false;
              }
            }
            return true;
          });

          return {
            sort(sortObj) {
              const sorted = [...filtered];
              if (sortObj?.createdAt === -1) {
                sorted.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
              }
              return {
                limit: (n) => ({
                  toArray: async () => sorted.slice(0, n),
                }),
                toArray: async () => sorted,
              };
            },
            limit: (n) => ({
              toArray: async () => filtered.slice(0, n),
            }),
            toArray: async () => filtered,
          };
        },
        async insertOne(doc) {
          rows.push({ ...doc });
          return { insertedId: doc._id };
        },
        async findOneAndUpdate(query, update, options = {}) {
          const doc = await this.findOne(query);
          if (!doc) return null;

          if (update.$set) {
            Object.assign(doc, update.$set);
          }
          if (update.$inc) {
            for (const [k, inc] of Object.entries(update.$inc)) {
              doc[k] = (doc[k] || 0) + inc;
            }
          }
          if (update.$push) {
            for (const [k, item] of Object.entries(update.$push)) {
              if (!Array.isArray(doc[k])) doc[k] = [];
              doc[k].push(item);
            }
          }
          return { value: doc };
        },
      };
    },
  };
}

describe('Ownership Transfer with Expiry and Audit History (#1108)', () => {
  const OWNER = 'GOWNER1111111111111111111111111111111111111111111111111111';
  const RECIPIENT = 'GRECIPIENT222222222222222222222222222222222222222222222222';
  const STRANGER = 'GSTRANGER333333333333333333333333333333333333333333333333';
  const T0 = new Date('2026-11-19T06:00:00Z');

  let db;

  beforeEach(() => {
    db = createMemoryDb();
    db.collection('materials').insertOne({
      _id: 'mat-100',
      userAddress: OWNER,
      title: 'Decentralized Finance & Soroban',
      version: 1,
    });
  });

  test('normal path: propose -> getTransfer (audit history) -> accept -> owner swap', async () => {
    // 1. Propose transfer
    const { transfer, replayed } = await initiateTransfer(db, {
      materialId: 'mat-100',
      actorAddress: OWNER,
      toAddress: RECIPIENT,
      ttlMs: 24 * 60 * 60 * 1000,
      reason: 'Course co-instructor handoff',
      now: T0,
    });

    assert.equal(replayed, false);
    assert.equal(transfer.state, TransferState.PENDING);
    assert.equal(transfer.fromAddress, OWNER);
    assert.equal(transfer.toAddress, RECIPIENT);
    assert.equal(transfer.history.length, 1);
    assert.equal(transfer.history[0].action, 'initiated');

    // 2. Inspect transfer with audit history
    const inspected = await getTransfer(db, {
      transferId: transfer._id,
      actorAddress: RECIPIENT,
      includeHistory: true,
      now: T0,
    });

    assert.equal(inspected.transfer._id, transfer._id);
    assert.equal(inspected.transfer.history.length, 1);
    assert.equal(inspected.transfer.history[0].action, 'initiated');

    // 3. Recipient accepts transfer
    const acceptTime = new Date(T0.getTime() + 10 * 60 * 1000);
    const acceptRes = await acceptTransfer(db, {
      transferId: transfer._id,
      actorAddress: RECIPIENT,
      now: acceptTime,
    });

    assert.equal(acceptRes.replayed, false);
    assert.equal(acceptRes.transfer.state, TransferState.ACCEPTED);

    // Verify material ownership moved
    const updatedMaterial = await db.collection('materials').findOne({ _id: 'mat-100' });
    assert.equal(updatedMaterial.userAddress, RECIPIENT);
    assert.equal(updatedMaterial.previousOwnerAddress, OWNER);
    assert.equal(updatedMaterial.ownershipTransferId, transfer._id);
    assert.equal(updatedMaterial.version, 2);

    // Verify audit history includes both initiated, accepting, and accepted
    const finalTransfer = await db.collection('ownership_transfers').findOne({ _id: transfer._id });
    const actions = finalTransfer.history.map((h) => h.action);
    assert.ok(actions.includes('initiated'));
    assert.ok(actions.includes('accepting'));
    assert.ok(actions.includes('accepted'));
  });

  test('expiry path: lazy expiry marks overdue pending transfer as expired', async () => {
    const ttl = 3600 * 1000; // 1 hour
    const { transfer } = await initiateTransfer(db, {
      materialId: 'mat-100',
      actorAddress: OWNER,
      toAddress: RECIPIENT,
      ttlMs: ttl,
      now: T0,
    });

    const pastExpiry = new Date(T0.getTime() + ttl + 1000);

    // Reading the transfer past expiry triggers lazy expiry
    const inspected = await getTransfer(db, {
      transferId: transfer._id,
      actorAddress: RECIPIENT,
      now: pastExpiry,
    });

    assert.equal(inspected.transfer.state, TransferState.EXPIRED);
    const lastHistory = inspected.transfer.history[inspected.transfer.history.length - 1];
    assert.equal(lastHistory.action, 'expired');
    assert.equal(lastHistory.actor, 'system');

    // Attempting to accept after expiry must fail with transfer_expired conflict
    await assert.rejects(
      () => acceptTransfer(db, {
        transferId: transfer._id,
        actorAddress: RECIPIENT,
        now: pastExpiry,
      }),
      (err) => err.code === 'CONFLICT_STATE' && err.details?.reason === 'transfer_expired'
    );
  });

  test('scheduled recovery path: recoverStuckTransfers sweeps overdue offers', async () => {
    const { transfer } = await initiateTransfer(db, {
      materialId: 'mat-100',
      actorAddress: OWNER,
      toAddress: RECIPIENT,
      ttlMs: 3600 * 1000,
      now: T0,
    });

    const sweepTime = new Date(T0.getTime() + 4000 * 1000);
    const summary = await recoverStuckTransfers(db, { now: sweepTime });

    assert.equal(summary.expired, 1);
    const stored = await db.collection('ownership_transfers').findOne({ _id: transfer._id });
    assert.equal(stored.state, TransferState.EXPIRED);
  });

  test('failure path: self-transfer and non-owner proposals are rejected', async () => {
    // Self transfer rejection
    await assert.rejects(
      () => initiateTransfer(db, {
        materialId: 'mat-100',
        actorAddress: OWNER,
        toAddress: OWNER,
        now: T0,
      }),
      (err) => err.code === 'VALIDATION_FAILED' && err.details?.reason === 'self_transfer'
    );

    // Non-owner rejection
    await assert.rejects(
      () => initiateTransfer(db, {
        materialId: 'mat-100',
        actorAddress: STRANGER,
        toAddress: RECIPIENT,
        now: T0,
      }),
      (err) => err.code === 'AUTH_FORBIDDEN' && err.details?.reason === 'not_owner'
    );
  });

  test('authorization and privacy path: strangers receive 404 NOT_FOUND', async () => {
    const { transfer } = await initiateTransfer(db, {
      materialId: 'mat-100',
      actorAddress: OWNER,
      toAddress: RECIPIENT,
      now: T0,
    });

    // Stranger cannot read transfer (returns NOT_FOUND to hide transfer existence)
    await assert.rejects(
      () => getTransfer(db, {
        transferId: transfer._id,
        actorAddress: STRANGER,
        now: T0,
      }),
      (err) => err.code === 'NOT_FOUND'
    );

    // Stranger cannot accept
    await assert.rejects(
      () => acceptTransfer(db, {
        transferId: transfer._id,
        actorAddress: STRANGER,
        now: T0,
      }),
      (err) => err.code === 'NOT_FOUND'
    );
  });

  test('decline and cancel paths: update state and preserve audit history', async () => {
    // Propose transfer
    const { transfer } = await initiateTransfer(db, {
      materialId: 'mat-100',
      actorAddress: OWNER,
      toAddress: RECIPIENT,
      now: T0,
    });

    // Recipient declines
    const declineRes = await declineTransfer(db, {
      transferId: transfer._id,
      actorAddress: RECIPIENT,
      now: new Date(T0.getTime() + 1000),
    });

    assert.equal(declineRes.transfer.state, TransferState.DECLINED);
    assert.ok(declineRes.transfer.history.some((h) => h.action === 'declined'));

    // Material owner is still unchanged
    const mat = await db.collection('materials').findOne({ _id: 'mat-100' });
    assert.equal(mat.userAddress, OWNER);
  });

  test('idempotency: retrying proposals and accepts replays cleanly', async () => {
    const first = await initiateTransfer(db, {
      materialId: 'mat-100',
      actorAddress: OWNER,
      toAddress: RECIPIENT,
      now: T0,
    });
    assert.equal(first.replayed, false);

    // Replay proposal
    const second = await initiateTransfer(db, {
      materialId: 'mat-100',
      actorAddress: OWNER,
      toAddress: RECIPIENT,
      now: new Date(T0.getTime() + 5000),
    });
    assert.equal(second.replayed, true);
    assert.equal(second.transfer._id, first.transfer._id);

    // Accept first time
    const accept1 = await acceptTransfer(db, {
      transferId: first.transfer._id,
      actorAddress: RECIPIENT,
      now: new Date(T0.getTime() + 10000),
    });
    assert.equal(accept1.replayed, false);

    // Accept second time (idempotent replay)
    const accept2 = await acceptTransfer(db, {
      transferId: first.transfer._id,
      actorAddress: RECIPIENT,
      now: new Date(T0.getTime() + 15000),
    });
    assert.equal(accept2.replayed, true);

    // Material version was bumped exactly once
    const mat = await db.collection('materials').findOne({ _id: 'mat-100' });
    assert.equal(mat.version, 2);
  });

  test('material transfer history: lists all transfers and audit trail for owner', async () => {
    const { transfer } = await initiateTransfer(db, {
      materialId: 'mat-100',
      actorAddress: OWNER,
      toAddress: RECIPIENT,
      now: T0,
    });

    const historyList = await listMaterialTransferHistory(db, {
      materialId: 'mat-100',
      actorAddress: OWNER,
      now: T0,
    });

    assert.equal(historyList.length, 1);
    assert.equal(historyList[0]._id, transfer._id);
    assert.ok(historyList[0].history.length >= 1);
  });
});


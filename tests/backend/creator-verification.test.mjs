import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VERIFICATION_STATUS,
  REVOCATION_REASONS,
  isCreatorVerified,
  authorizeVerificationManagement,
  revokeCreatorVerification,
  expireStaleCreatorVerifications,
  reinstateCreatorVerification,
  rollbackVerificationAction,
} from '../../src/lib/verification/creatorVerification.js';

function createMockDb(initialData = {}) {
  const collections = {};

  for (const [colName, docs] of Object.entries(initialData)) {
    collections[colName] = new Map();
    for (const [key, doc] of Object.entries(docs)) {
      collections[colName].set(key, JSON.parse(JSON.stringify(doc)));
    }
  }

  return {
    collection(name) {
      if (!collections[name]) collections[name] = new Map();
      const map = collections[name];

      return {
        async findOne(query) {
          for (const doc of map.values()) {
            const matches = Object.entries(query).every(([k, v]) => {
              if (k === '$or' && Array.isArray(v)) {
                return v.some((subQ) => Object.entries(subQ).every(([sk, sv]) => doc[sk] === sv));
              }
              return doc[k] === v;
            });
            if (matches) return JSON.parse(JSON.stringify(doc));
          }
          return null;
        },
        find(query = {}) {
          return {
            async toArray() {
              return Array.from(map.values())
                .filter((doc) => {
                  return Object.entries(query).every(([k, v]) => {
                    if (k === 'credential.status') return doc.credential?.status === v;
                    if (k === 'credential.expiresAt' && v?.$lte) {
                      return new Date(doc.credential?.expiresAt) <= new Date(v.$lte);
                    }
                    return doc[k] === v;
                  });
                })
                .map((d) => JSON.parse(JSON.stringify(d)));
            },
          };
        },
        async updateOne(query, update) {
          let foundKey = null;
          for (const [key, doc] of map.entries()) {
            const matches = Object.entries(query).every(([k, v]) => doc[k] === v);
            if (matches) {
              foundKey = key;
              break;
            }
          }

          if (foundKey) {
            const existing = map.get(foundKey);
            if (update.$set) {
              for (const [field, val] of Object.entries(update.$set)) {
                if (field.startsWith('credential.')) {
                  if (!existing.credential) existing.credential = {};
                  existing.credential[field.replace('credential.', '')] = val;
                } else {
                  existing[field] = val;
                }
              }
            }
            if (update.$unset) {
              for (const field of Object.keys(update.$unset)) {
                if (field.startsWith('credential.')) {
                  if (existing.credential) delete existing.credential[field.replace('credential.', '')];
                } else {
                  delete existing[field];
                }
              }
            }
            return { matchedCount: 1, modifiedCount: 1 };
          }
          return { matchedCount: 0, modifiedCount: 0 };
        },
        async updateMany(query, update) {
          let count = 0;
          for (const [key, doc] of map.entries()) {
            const matches = Object.entries(query).every(([k, v]) => {
              if (k === '$or' && Array.isArray(v)) {
                return v.some((subQ) => Object.entries(subQ).every(([sk, sv]) => doc[sk] === sv));
              }
              return doc[k] === v;
            });
            if (matches) {
              if (update.$set) Object.assign(doc, update.$set);
              count++;
            }
          }
          return { matchedCount: count, modifiedCount: count };
        },
      };
    },
  };
}

test('isCreatorVerified correctly evaluates active, expired, and revoked credentials', () => {
  const future = new Date('2027-01-01T00:00:00.000Z');
  const past = new Date('2025-01-01T00:00:00.000Z');
  const clock = new Date('2026-06-01T00:00:00.000Z');

  // 1. Actively verified with future expiry -> true
  assert.equal(
    isCreatorVerified({ status: VERIFICATION_STATUS.ACTIVE, expiresAt: future.toISOString() }, clock),
    true
  );

  // 2. Active without expiry (indefinite) -> true
  assert.equal(isCreatorVerified({ status: VERIFICATION_STATUS.ACTIVE }, clock), true);

  // 3. Expired credential -> false
  assert.equal(
    isCreatorVerified({ status: VERIFICATION_STATUS.ACTIVE, expiresAt: past.toISOString() }, clock),
    false
  );

  // 4. Revoked credential -> false
  assert.equal(
    isCreatorVerified({ status: VERIFICATION_STATUS.REVOKED, expiresAt: future.toISOString() }, clock),
    false
  );

  // 5. Pending or rejected -> false
  assert.equal(isCreatorVerified({ status: VERIFICATION_STATUS.PENDING }, clock), false);
  assert.equal(isCreatorVerified({ status: VERIFICATION_STATUS.REJECTED }, clock), false);
  assert.equal(isCreatorVerified(null), false);
});

test('authorization path: rejects unauthorized callers', async () => {
  const db = createMockDb({});

  // 1. Missing actor
  await assert.rejects(
    async () => {
      await revokeCreatorVerification({ db, target: 'app-1', reason: 'violation', actor: null });
    },
    (err) => err.code === 'AUTH_FORBIDDEN'
  );

  // 2. Learner role without verification permission
  await assert.rejects(
    async () => {
      await revokeCreatorVerification({
        db,
        target: 'app-1',
        reason: 'violation',
        actor: { role: 'learner', permissions: [] },
      });
    },
    (err) => err.code === 'AUTH_FORBIDDEN'
  );

  // 3. Admin role succeeds authorization check
  assert.doesNotThrow(() => {
    authorizeVerificationManagement({ actor: { role: 'admin' } });
  });

  // 4. Custom permission succeeds
  assert.doesNotThrow(() => {
    authorizeVerificationManagement({ actor: { permissions: ['admin:verification:manage'] } });
  });
});

test('failure path: handles invalid targets, missing reasons, and duplicate revocations', async () => {
  const db = createMockDb({
    verification_applications: {
      'app-revoked': {
        _id: 'app-revoked',
        userUuid: 'user-revoked',
        status: 'revoked',
      },
    },
    profiles: {
      'user-revoked': {
        uuid: 'user-revoked',
        credential: { status: VERIFICATION_STATUS.REVOKED, revokedAt: '2026-01-01' },
      },
    },
  });

  // 1. Missing target
  await assert.rejects(
    async () => {
      await revokeCreatorVerification({ db, target: '', reason: 'Some reason', actor: 'admin' });
    },
    (err) => err.code === 'VALIDATION_FIELD'
  );

  // 2. Missing reason
  await assert.rejects(
    async () => {
      await revokeCreatorVerification({ db, target: 'app-revoked', reason: '', actor: 'admin' });
    },
    (err) => err.code === 'VALIDATION_FIELD'
  );

  // 3. Target not found
  await assert.rejects(
    async () => {
      await revokeCreatorVerification({ db, target: 'non-existent-app', reason: 'reason', actor: 'admin' });
    },
    (err) => err.code === 'NOT_FOUND'
  );

  // 4. Duplicate revocation on already revoked profile
  await assert.rejects(
    async () => {
      await revokeCreatorVerification({ db, target: 'app-revoked', reason: 'reason', actor: 'admin' });
    },
    (err) => err.code === 'VALIDATION_FIELD' && err.message.includes('already revoked')
  );
});

test('normal path: revokes verification, captures rollbackSnapshot, and updates application and profile', async () => {
  const db = createMockDb({
    verification_applications: {
      'app-1': {
        _id: 'app-1',
        userUuid: 'user-1',
        requestedType: 'institution',
        status: 'approved',
      },
    },
    profiles: {
      'user-1': {
        uuid: 'user-1',
        profileType: 'institution',
        credential: {
          status: VERIFICATION_STATUS.ACTIVE,
          evidence: 'urn:eduvault:verification:app-1',
          expiresAt: '2027-01-01T00:00:00.000Z',
        },
      },
    },
    materials: {
      'mat-1': {
        materialId: 'mat-1',
        creatorUuid: 'user-1',
        creator: { credential: { status: VERIFICATION_STATUS.ACTIVE } },
      },
    },
  });

  const res = await revokeCreatorVerification({
    db,
    target: 'app-1',
    reason: REVOCATION_REASONS.POLICY_VIOLATION,
    actor: { id: 'admin-1', role: 'admin' },
    now: 1_770_000_000_000,
  });

  assert.equal(res.success, true);
  assert.equal(res.status, VERIFICATION_STATUS.REVOKED);
  assert.ok(res.rollbackSnapshot);
  assert.equal(res.rollbackSnapshot.previousProfileType, 'institution');
  assert.equal(res.rollbackSnapshot.previousCredential.status, VERIFICATION_STATUS.ACTIVE);

  // Verify updated DB states
  const app = await db.collection('verification_applications').findOne({ _id: 'app-1' });
  assert.equal(app.status, VERIFICATION_STATUS.REVOKED);
  assert.equal(app.revocationReason, REVOCATION_REASONS.POLICY_VIOLATION);

  const prof = await db.collection('profiles').findOne({ uuid: 'user-1' });
  assert.equal(prof.profileType, 'individual');
  assert.equal(prof.credential.status, VERIFICATION_STATUS.REVOKED);
  assert.equal(prof.credential.revocationReason, REVOCATION_REASONS.POLICY_VIOLATION);
});

test('retry path: recovers from transient database failure during revocation', async () => {
  const db = createMockDb({
    verification_applications: {
      'app-retry': {
        _id: 'app-retry',
        userUuid: 'user-retry',
        status: 'approved',
      },
    },
    profiles: {
      'user-retry': {
        uuid: 'user-retry',
        credential: { status: VERIFICATION_STATUS.ACTIVE },
      },
    },
  });

  let attempts = 0;
  const originalCollection = db.collection.bind(db);
  db.collection = (name) => {
    const col = originalCollection(name);
    if (name === 'verification_applications') {
      const origUpdate = col.updateOne.bind(col);
      col.updateOne = async (...args) => {
        attempts++;
        if (attempts === 1) {
          throw new Error('Transient write conflict on application doc');
        }
        return origUpdate(...args);
      };
    }
    return col;
  };

  const res = await revokeCreatorVerification({
    db,
    target: 'app-retry',
    reason: 'Policy check',
    actor: 'admin',
    maxRetries: 2,
    retryDelayMs: 1,
    sleep: async () => {},
  });

  assert.equal(res.success, true);
  assert.equal(res.retriesUsed, 1);
});

test('expiry sweep: expireStaleCreatorVerifications transitions expired credentials and leaves active ones untouched', async () => {
  const now = new Date('2026-06-01T00:00:00.000Z');
  const past = new Date('2026-05-01T00:00:00.000Z');
  const future = new Date('2027-01-01T00:00:00.000Z');

  const db = createMockDb({
    profiles: {
      'user-expired': {
        uuid: 'user-expired',
        credential: { status: VERIFICATION_STATUS.ACTIVE, expiresAt: past.toISOString() },
      },
      'user-active': {
        uuid: 'user-active',
        credential: { status: VERIFICATION_STATUS.ACTIVE, expiresAt: future.toISOString() },
      },
    },
    verification_applications: {
      'app-expired': { userUuid: 'user-expired', status: 'approved' },
      'app-active': { userUuid: 'user-active', status: 'approved' },
    },
  });

  const sweepReport = await expireStaleCreatorVerifications({
    db,
    now: now.getTime(),
    actor: 'system',
  });

  assert.equal(sweepReport.checked, 1);
  assert.equal(sweepReport.expiredCount, 1);
  assert.deepEqual(sweepReport.expiredUuids, ['user-expired']);

  // Verify expired profile was transitioned
  const expiredProf = await db.collection('profiles').findOne({ uuid: 'user-expired' });
  assert.equal(expiredProf.credential.status, VERIFICATION_STATUS.EXPIRED);

  // Verify active profile was left active
  const activeProf = await db.collection('profiles').findOne({ uuid: 'user-active' });
  assert.equal(activeProf.credential.status, VERIFICATION_STATUS.ACTIVE);
});

test('recovery and rollback: reinstate and rollbackVerificationAction restore active credential', async () => {
  const db = createMockDb({
    verification_applications: {
      'app-rec': {
        _id: 'app-rec',
        userUuid: 'user-rec',
        status: 'approved',
      },
    },
    profiles: {
      'user-rec': {
        uuid: 'user-rec',
        profileType: 'institution',
        credential: { status: VERIFICATION_STATUS.ACTIVE, expiresAt: '2027-01-01' },
      },
    },
  });

  // 1. Revoke first
  const revokeRes = await revokeCreatorVerification({
    db,
    target: 'app-rec',
    reason: 'Temporary investigation',
    actor: 'admin',
  });
  assert.equal(revokeRes.status, VERIFICATION_STATUS.REVOKED);

  // 2. Rollback revocation using rollbackSnapshot
  const rollbackRes = await rollbackVerificationAction(db, revokeRes.rollbackSnapshot);
  assert.equal(rollbackRes.success, true);

  const restoredProf = await db.collection('profiles').findOne({ uuid: 'user-rec' });
  assert.equal(restoredProf.credential.status, VERIFICATION_STATUS.ACTIVE);
  assert.equal(restoredProf.profileType, 'institution');

  // 3. Reinstatement API function test
  // Revoke again
  await revokeCreatorVerification({ db, target: 'app-rec', reason: 'Dispute', actor: 'admin' });
  // Reinstate with 180 days extension
  const reinstateRes = await reinstateCreatorVerification({
    db,
    target: 'app-rec',
    actor: 'admin',
    durationDays: 180,
  });
  assert.equal(reinstateRes.success, true);
  assert.equal(reinstateRes.status, VERIFICATION_STATUS.ACTIVE);

  const reinstatedProf = await db.collection('profiles').findOne({ uuid: 'user-rec' });
  assert.equal(reinstatedProf.credential.status, VERIFICATION_STATUS.ACTIVE);
  assert.ok(new Date(reinstatedProf.credential.expiresAt) > new Date());
});

import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import {
  isSessionRevoked,
  revokeUserSessions,
  revokeTokenFamily,
  SECURITY_EVENT_TYPES,
  getRevocationHistory,
} from '../../src/lib/auth/sessionRevocation.js';

function createMockCollection(initialDocs = []) {
  const docs = [...initialDocs];

  return {
    _docs: docs,
    async findOne(query) {
      return docs.find(doc => matchesQuery(doc, query)) || null;
    },
    find(query = {}) {
      const results = docs.filter(doc => matchesQuery(doc, query));
      return {
        sort: () => ({
          limit: (n) => ({
            toArray: async () => results.slice(0, n),
          }),
          toArray: async () => results,
        }),
        toArray: async () => results,
      };
    },
    async insertOne(doc) {
      const newDoc = { _id: doc._id || `id_${Date.now()}_${Math.random()}`, ...doc };
      docs.push(newDoc);
      return { insertedId: newDoc._id };
    },
    async updateOne(query, update) {
      const doc = docs.find(d => matchesQuery(d, query));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(doc, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOneAndUpdate(query, update, options = {}) {
      const doc = docs.find(d => matchesQuery(d, query));
      if (!doc) return null;
      applyUpdate(doc, update);
      return doc;
    },
    async updateMany(query, update) {
      let modifiedCount = 0;
      for (const doc of docs) {
        if (matchesQuery(doc, query)) {
          applyUpdate(doc, update);
          modifiedCount++;
        }
      }
      return { matchedCount: modifiedCount, modifiedCount };
    },
    async deleteOne(query) {
      const idx = docs.findIndex(d => matchesQuery(d, query));
      if (idx !== -1) {
        docs.splice(idx, 1);
        return { deletedCount: 1 };
      }
      return { deletedCount: 0 };
    },
    async deleteMany(query) {
      let deleted = 0;
      for (let i = docs.length - 1; i >= 0; i--) {
        if (matchesQuery(docs[i], query)) {
          docs.splice(i, 1);
          deleted++;
        }
      }
      return { deletedCount: deleted };
    },
  };
}

function matchesQuery(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;
  for (const [key, val] of Object.entries(query)) {
    if (key === '$or') {
      return val.some(subQuery => matchesQuery(doc, subQuery));
    }
    if (val && typeof val === 'object' && val.$ne !== undefined) {
      if (doc[key] === val.$ne) return false;
      continue;
    }
    if (val && typeof val === 'object' && val.$lt !== undefined) {
      if (!(doc[key] < val.$lt)) return false;
      continue;
    }
    if (String(doc[key]) !== String(val)) {
      return false;
    }
  }
  return true;
}

function applyUpdate(doc, update) {
  if (update.$set) {
    Object.assign(doc, update.$set);
  }
  if (update.$inc) {
    for (const [key, incVal] of Object.entries(update.$inc)) {
      doc[key] = (doc[key] || 0) + incVal;
    }
  }
  if (update.$addToSet) {
    for (const [key, item] of Object.entries(update.$addToSet)) {
      if (!Array.isArray(doc[key])) doc[key] = [];
      if (!doc[key].includes(item)) doc[key].push(item);
    }
  }
}

describe('Stale Session and Token Revocation (Issue #1006)', () => {
  let mockDb;
  let usersCol;
  let refreshTokensCol;
  let revocationsCol;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-key-32-chars-long-123456';
    usersCol = createMockCollection([
      {
        _id: '507f1f77bcf86cd799439011',
        walletAddress: 'GA111111111111111111111111111111111111111111111111111111',
        role: 'user',
        sessionVersion: 1,
      },
      {
        _id: '507f1f77bcf86cd799439022',
        walletAddress: 'GA222222222222222222222222222222222222222222222222222222',
        role: 'admin',
        sessionVersion: 1,
      },
    ]);
    refreshTokensCol = createMockCollection([]);
    revocationsCol = createMockCollection([]);

    mockDb = {
      collection(name) {
        if (name === 'users') return usersCol;
        if (name === 'refresh_tokens') return refreshTokensCol;
        if (name === 'session_revocations') return revocationsCol;
        return createMockCollection([]);
      },
    };
  });

  describe('isSessionRevoked Evaluation', () => {
    test('normal path: unrevoked token matches user state and passes', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const tokenPayload = {
        sub: '507f1f77bcf86cd799439011',
        iat: nowSec - 60,
        exp: nowSec + 840,
        sessionVersion: 1,
      };
      const user = {
        _id: '507f1f77bcf86cd799439011',
        sessionVersion: 1,
      };

      const result = isSessionRevoked(tokenPayload, user);
      assert.equal(result.revoked, false);
    });

    test('failure path: token issued before tokensValidAfter cutoff is revoked', () => {
      const cutoffTime = new Date('2026-10-17T12:00:00Z');
      const cutoffSec = Math.floor(cutoffTime.getTime() / 1000);

      const staleToken = {
        sub: '507f1f77bcf86cd799439011',
        iat: cutoffSec - 100, // Issued before security event
        sessionVersion: 1,
      };
      const user = {
        _id: '507f1f77bcf86cd799439011',
        tokensValidAfter: cutoffTime.toISOString(),
        sessionVersion: 1,
      };

      const result = isSessionRevoked(staleToken, user);
      assert.equal(result.revoked, true);
      assert.equal(result.code, 'SESSION_REVOKED');
      assert.ok(result.reason.includes('before security event cutoff'));
    });

    test('failure path: token with obsolete sessionVersion is revoked as STALE_SESSION', () => {
      const token = {
        sub: '507f1f77bcf86cd799439011',
        iat: Math.floor(Date.now() / 1000),
        sessionVersion: 1, // Stale version
      };
      const user = {
        _id: '507f1f77bcf86cd799439011',
        sessionVersion: 3, // Current version bumped after security events
      };

      const result = isSessionRevoked(token, user);
      assert.equal(result.revoked, true);
      assert.equal(result.code, 'STALE_SESSION');
    });

    test('failure path: token belonging to a revoked family is rejected', () => {
      const token = {
        sub: '507f1f77bcf86cd799439011',
        sessionFamilyId: 'family_compromised_xyz',
        sessionVersion: 1,
      };
      const user = {
        _id: '507f1f77bcf86cd799439011',
        sessionVersion: 1,
        revokedFamilies: ['family_compromised_xyz'],
      };

      const result = isSessionRevoked(token, user);
      assert.equal(result.revoked, true);
      assert.equal(result.code, 'FAMILY_REVOKED');
    });

    test('failure path: blacklisted jti is rejected', () => {
      const token = {
        sub: '507f1f77bcf86cd799439011',
        jti: 'token_bad_123',
        sessionVersion: 1,
      };
      const user = {
        _id: '507f1f77bcf86cd799439011',
        sessionVersion: 1,
        revokedTokenIds: ['token_bad_123'],
      };

      const result = isSessionRevoked(token, user);
      assert.equal(result.revoked, true);
      assert.equal(result.code, 'TOKEN_BLACKLISTED');
    });
  });

  describe('revokeUserSessions Execution', () => {
    test('updates user cutoff timestamp, increments sessionVersion, and revokes refresh tokens', async () => {
      const userId = '507f1f77bcf86cd799439011';
      await refreshTokensCol.insertOne({
        userId,
        token: 'refresh_tok_1',
        sessionFamilyId: 'fam_1',
        revoked: false,
      });
      await refreshTokensCol.insertOne({
        userId,
        token: 'refresh_tok_2',
        sessionFamilyId: 'fam_2',
        revoked: false,
      });

      const fixedDate = new Date('2026-10-17T14:30:00Z');
      const result = await revokeUserSessions(mockDb, userId, {
        eventType: SECURITY_EVENT_TYPES.ROLE_CHANGED,
        reason: 'User role changed from user to creator',
        actor: 'admin_1',
        now: fixedDate,
      });

      assert.equal(result.success, true);
      assert.equal(result.tokensValidAfter, fixedDate.toISOString());
      assert.equal(result.sessionVersion, 2);
      assert.equal(result.refreshTokensRevoked, 2);

      // Verify user document
      const user = await usersCol.findOne({ _id: userId });
      assert.equal(user.sessionVersion, 2);
      assert.equal(user.tokensValidAfter, fixedDate.toISOString());
      assert.equal(user.lastSecurityEvent.eventType, 'role_changed');

      // Verify refresh tokens were marked revoked
      const tokens = await refreshTokensCol.find({ userId });
      const tokenList = await tokens.toArray();
      assert.equal(tokenList.every(t => t.revoked === true), true);

      // Verify durable audit history
      const history = await getRevocationHistory(mockDb, userId);
      assert.equal(history.length, 1);
      assert.equal(history[0].eventType, 'role_changed');
      assert.equal(history[0].actor, 'admin_1');
    });

    test('preserves specific family when preserveFamilyId is provided (e.g. logout other devices)', async () => {
      const userId = '507f1f77bcf86cd799439011';
      await refreshTokensCol.insertOne({
        userId,
        token: 'current_device_tok',
        sessionFamilyId: 'current_fam',
        revoked: false,
      });
      await refreshTokensCol.insertOne({
        userId,
        token: 'other_device_tok',
        sessionFamilyId: 'other_fam',
        revoked: false,
      });

      const result = await revokeUserSessions(mockDb, userId, {
        eventType: SECURITY_EVENT_TYPES.ALL_SESSIONS_REVOKED,
        reason: 'Logout other devices',
        preserveFamilyId: 'current_fam',
      });

      assert.equal(result.refreshTokensRevoked, 1);
      const currentToken = await refreshTokensCol.findOne({ sessionFamilyId: 'current_fam' });
      assert.equal(currentToken.revoked, false);
      const otherToken = await refreshTokensCol.findOne({ sessionFamilyId: 'other_fam' });
      assert.equal(otherToken.revoked, true);
    });
  });

  describe('Session Family & Token Reuse Revocation', () => {
    test('revokeTokenFamily invalidates only targeted session family', async () => {
      const userId = '507f1f77bcf86cd799439011';
      await refreshTokensCol.insertOne({
        userId,
        token: 'tok_a',
        sessionFamilyId: 'fam_target',
        revoked: false,
      });
      await refreshTokensCol.insertOne({
        userId,
        token: 'tok_b',
        sessionFamilyId: 'fam_safe',
        revoked: false,
      });

      const res = await revokeTokenFamily(mockDb, userId, 'fam_target', {
        reason: 'Targeted device logout',
      });

      assert.equal(res.success, true);
      assert.equal(res.refreshTokensRevoked, 1);

      const targetTok = await refreshTokensCol.findOne({ sessionFamilyId: 'fam_target' });
      assert.equal(targetTok.revoked, true);
      const safeTok = await refreshTokensCol.findOne({ sessionFamilyId: 'fam_safe' });
      assert.equal(safeTok.revoked, false);

      const user = await usersCol.findOne({ _id: userId });
      assert.ok(user.revokedFamilies.includes('fam_target'));
    });
  });

  describe('Recovery & Re-authentication Lifecycle', () => {
    test('post-revocation login creates valid session with new version and fresh iat', () => {
      const cutoffTime = new Date('2026-10-17T12:00:00Z');
      const cutoffSec = Math.floor(cutoffTime.getTime() / 1000);

      // Old revoked user state
      const user = {
        _id: '507f1f77bcf86cd799439011',
        tokensValidAfter: cutoffTime.toISOString(),
        sessionVersion: 2,
      };

      // 1. Old token before revocation is revoked
      const oldToken = {
        sub: user._id,
        iat: cutoffSec - 60,
        sessionVersion: 1,
      };
      assert.equal(isSessionRevoked(oldToken, user).revoked, true);

      // 2. Freshly issued token after re-authentication
      const freshToken = {
        sub: user._id,
        iat: cutoffSec + 10,
        sessionVersion: 2,
      };
      const freshCheck = isSessionRevoked(freshToken, user);
      assert.equal(freshCheck.revoked, false);
    });

    test('sequential security events increment sessionVersion monotonically', async () => {
      const userId = '507f1f77bcf86cd799439011';
      
      const ev1 = await revokeUserSessions(mockDb, userId, {
        eventType: SECURITY_EVENT_TYPES.ROLE_CHANGED,
      });
      assert.equal(ev1.sessionVersion, 2);

      const ev2 = await revokeUserSessions(mockDb, userId, {
        eventType: SECURITY_EVENT_TYPES.CREDENTIALS_CHANGED,
      });
      assert.equal(ev2.sessionVersion, 3);

      const ev3 = await revokeUserSessions(mockDb, userId, {
        eventType: SECURITY_EVENT_TYPES.ALL_SESSIONS_REVOKED,
      });
      assert.equal(ev3.sessionVersion, 4);

      const user = await usersCol.findOne({ _id: userId });
      assert.equal(user.sessionVersion, 4);
    });

    test('error handling: missing parameters throw descriptive errors', async () => {
      await assert.rejects(
        () => revokeUserSessions(null, 'userId'),
        /Database connection required/
      );
      await assert.rejects(
        () => revokeUserSessions(mockDb, null),
        /userId required/
      );
      assert.equal(isSessionRevoked(null, {}).code, 'INVALID_TOKEN');
      assert.equal(isSessionRevoked({}, null).code, 'USER_NOT_FOUND');
    });
  });
});


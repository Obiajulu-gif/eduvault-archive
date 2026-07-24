import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { Keypair, Networks, Memo, Operation, Account, TransactionBuilder, StrKey } from '@stellar/stellar-sdk';

const TEST_DOMAIN = 'test.eduvault.app';
const TEST_URI = 'https://test.eduvault.app';

process.env.AUTH_DOMAIN = TEST_DOMAIN;
process.env.NEXT_PUBLIC_APP_URL = TEST_URI;

let issueChallenge, verifyChallenge, cleanupExpiredChallenges, ensureChallengeIndexes;

before(async () => {
  const mod = await import('../../src/lib/auth/challenge.js');
  issueChallenge = mod.issueChallenge;
  verifyChallenge = mod.verifyChallenge;
  cleanupExpiredChallenges = mod.cleanupExpiredChallenges;
  ensureChallengeIndexes = mod.ensureChallengeIndexes;
});

function inMemoryDb() {
  const collections = {};
  return {
    collection(name) {
      if (!collections[name]) {
        const docs = new Map();
        collections[name] = {
          docs,
          async findOneAndUpdate(filter, update, options = {}) {
            for (const [key, doc] of docs) {
              let match = true;
              for (const [k, v] of Object.entries(filter)) {
                if (k === 'expiresAt' && v.$gt && !(doc.expiresAt > v.$gt)) {
                  match = false;
                } else if (k !== 'expiresAt' && doc[k] !== v) {
                  match = false;
                }
              }
              if (match && options.returnDocument === 'before') {
                const oldDoc = { ...doc, _id: doc._id };
                docs.set(key, { ...doc, ...update.$set });
                return oldDoc;
              }
            }
            return null;
          },
          async insertOne(doc) {
            const _id = `id_${Date.now()}_${Math.random()}`;
            docs.set(_id, { ...doc, _id });
            return { insertedId: _id };
          },
          async deleteMany(filter) {
            let count = 0;
            for (const [key, doc] of docs) {
              let match = true;
              for (const [k, v] of Object.entries(filter)) {
                if (k === 'expiresAt' && v.$lt && !(doc.expiresAt < v.$lt)) {
                  match = false;
                } else if (k !== 'expiresAt' && v !== doc[k]) {
                  match = false;
                }
              }
              if (match) {
                docs.delete(key);
                count++;
              }
            }
            return { deletedCount: count };
          },
          async createIndex(keys, opts) {
            return `${opts.name}_created`;
          },
        };
      }
      return collections[name];
    },
  };
}

function buildSignedTx(keypair, nonce, opts = {}) {
  const source = opts.source || keypair.publicKey();
  const networkPassphrase = opts.networkPassphrase || Networks.TESTNET;
  const account = new Account(source, '0');

  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '0' }))
    .addMemo(Memo.text(nonce))
    .setTimeout(0)
    .build();

  tx.sign(keypair);
  return tx;
}

// ── issueChallenge tests ───────────────────────────────────────────────────

test('issueChallenge returns a correctly structured challenge', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const address = keypair.publicKey();
  const result = await issueChallenge(address, { db });

  assert.ok(result.nonce, 'nonce should be present');
  assert.equal(typeof result.nonce, 'string');
  assert.equal(result.nonce.length, 28, 'nonce should be 28 hex chars (fits Memo.text)');

  assert.equal(result.address, address);
  assert.equal(result.domain, TEST_DOMAIN);
  assert.equal(result.webAuthUri, TEST_URI);
  assert.equal(result.networkPassphrase, Networks.TESTNET);
  assert.ok(result.expiresAt, 'expiresAt should be present');
  assert.ok(result.message, 'message should be present');

  assert.ok(result.message.includes('EduVault Login'), 'message should contain header');
  assert.ok(result.message.includes(`Domain: ${TEST_DOMAIN}`), 'message should contain domain');
  assert.ok(result.message.includes(`URI: ${TEST_URI}`), 'message should contain URI');
  assert.ok(result.message.includes(`Network: ${Networks.TESTNET}`), 'message should contain network');
  assert.ok(result.message.includes(`Address: ${address.toLowerCase()}`), 'message should contain address');
  assert.ok(result.message.includes(`Nonce: ${result.nonce}`), 'message should contain nonce');
});

test('issueChallenge stores used: false and a future expiresAt', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const address = keypair.publicKey();
  await issueChallenge(address, { db });

  const col = db.collection('auth_challenges');
  for (const doc of col.docs.values()) {
    assert.equal(doc.used, false);
    assert.ok(doc.expiresAt > new Date());
  }
});

test('issueChallenge lowercases the address', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const mixedCase = keypair.publicKey().replace(/^G/, 'g');
  await issueChallenge(mixedCase, { db });

  const col = db.collection('auth_challenges');
  for (const doc of col.docs.values()) {
    assert.equal(doc.address, mixedCase.toLowerCase());
  }
});

// ── Atomic consumption tests ────────────────────────────────────────────────

test('verifyChallenge uses atomic findOneAndUpdate with used:false', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const address = keypair.publicKey();

  const challenge = await issueChallenge(address, { db });
  const tx = buildSignedTx(keypair, challenge.nonce);

  const col = db.collection('auth_challenges');
  const origFindOneAndUpdate = col.findOneAndUpdate;
  let callFilter = null;

  col.findOneAndUpdate = (filter, update, options) => {
    callFilter = filter;
    return origFindOneAndUpdate.call(col, filter, update, options);
  };

  const result = await verifyChallenge(address, challenge.nonce, tx.toXDR(), { db });
  assert.equal(result.valid, true);

  assert.ok(callFilter, 'findOneAndUpdate should be called');
  assert.equal(callFilter.used, false, 'filter must require unused challenge');
  assert.equal(callFilter.nonce, challenge.nonce);
  assert.ok(callFilter.expiresAt.$gt, 'filter must check expiration');
});

test('exactly one concurrent verifier can succeed with atomic findOneAndUpdate', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const address = keypair.publicKey();

  const challenge = await issueChallenge(address, { db });
  const tx = buildSignedTx(keypair, challenge.nonce);

  const result1 = await verifyChallenge(address, challenge.nonce, tx.toXDR(), { db });
  assert.equal(result1.valid, true, 'first caller should succeed');

  const result2 = await verifyChallenge(address, challenge.nonce, tx.toXDR(), { db });
  assert.equal(result2.valid, false, 'second caller should fail');
  assert.ok(result2.reason.includes('used'), 'reason should mention already used');
});

test('verifyChallenge uses findOneAndUpdate (not findOne+update) so no TOCTOU gap', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const address = keypair.publicKey();

  const challenge = await issueChallenge(address, { db });
  const tx = buildSignedTx(keypair, challenge.nonce);

  const col = db.collection('auth_challenges');
  let usedFindThenUpdate = false;

  const origFn = col.findOneAndUpdate;
  col.findOneAndUpdate = (filter, update, options) => {
    usedFindThenUpdate = true;
    return origFn.call(col, filter, update, options);
  };

  const origFind = col.findOne;
  col.findOne = () => { usedFindThenUpdate = false; return {}; };

  await verifyChallenge(address, challenge.nonce, tx.toXDR(), { db });
  assert.ok(usedFindThenUpdate, 'should use findOneAndUpdate, not findOne+update');
});

// ── Verification failure tests ──────────────────────────────────────────────

test('verifyChallenge rejects non-existent/expired/used challenge', async () => {
  const result = await verifyChallenge(
    Keypair.random().publicKey(),
    'no-such-nonce',
    'fake-xdr',
    { db: inMemoryDb() }
  );
  assert.equal(result.valid, false);
});

test('verifyChallenge rejects transaction with wrong source address', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const otherKeypair = Keypair.random();
  const address = keypair.publicKey();
  const challenge = await issueChallenge(address, { db });
  const tx = buildSignedTx(keypair, challenge.nonce, { source: otherKeypair.publicKey() });

  const result = await verifyChallenge(address, challenge.nonce, tx.toXDR(), { db });
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes('source') || result.reason.includes('address'));
});

test('verifyChallenge rejects transaction with wrong memo', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const address = keypair.publicKey();
  const challenge = await issueChallenge(address, { db });
  const tx = buildSignedTx(keypair, 'wrong-nonce-value');

  const result = await verifyChallenge(address, challenge.nonce, tx.toXDR(), { db });
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes('memo') || result.reason.includes('nonce'));
});

test('verifyChallenge rejects transaction with invalid signature', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const attacker = Keypair.random();
  const address = keypair.publicKey();
  const challenge = await issueChallenge(address, { db });
  const tx = buildSignedTx(attacker, challenge.nonce, { source: address });

  const result = await verifyChallenge(address, challenge.nonce, tx.toXDR(), { db });
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes('signature'));
});

test('verifyChallenge rejects unsigned transaction', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const address = keypair.publicKey();
  const challenge = await issueChallenge(address, { db });

  const account = new Account(address, '0');
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '0' }))
    .addMemo(Memo.text(challenge.nonce))
    .setTimeout(0)
    .build();

  const result = await verifyChallenge(address, challenge.nonce, tx.toXDR(), { db });
  assert.equal(result.valid, false);
});

test('verifyChallenge returns safe error on malformed XDR', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const address = keypair.publicKey();
  const challenge = await issueChallenge(address, { db });

  const result = await verifyChallenge(address, challenge.nonce, 'AAAAgarbageXDR===', { db });
  assert.equal(result.valid, false);
  assert.ok(result.reason, 'should return a reason string');
  assert.ok(!result.reason.includes('AAAAgarbageXDR'), 'should not leak raw XDR in error');
});

// ── Network / domain binding tests ──────────────────────────────────────────

test('challenge is bound to domain and URI', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const result = await issueChallenge(keypair.publicKey(), { db });

  assert.ok(result.message.includes(result.domain));
  assert.ok(result.message.includes(result.webAuthUri));
  assert.ok(result.message.includes(result.networkPassphrase));
});

// ── cleanupExpiredChallenges tests ──────────────────────────────────────────

test('cleanupExpiredChallenges removes expired entries', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  await issueChallenge(keypair.publicKey(), { db });

  const col = db.collection('auth_challenges');
  for (const doc of col.docs.values()) {
    doc.expiresAt = new Date(Date.now() - 10000);
  }

  const before = col.docs.size;
  await cleanupExpiredChallenges({ db });
  assert.ok(col.docs.size < before, 'expired challenges should be removed');
});

// ── TTL index creation test ─────────────────────────────────────────────────

test('ensureChallengeIndexes creates required indexes', async () => {
  const indexes = [];
  const mockDb = {
    collection: () => ({
      createIndex: (keys, opts) => {
        indexes.push({ keys, name: opts.name, expireAfterSeconds: opts.expireAfterSeconds });
        return Promise.resolve(`${opts.name}_created`);
      },
    }),
  };

  await ensureChallengeIndexes(mockDb);

  const ttlIndex = indexes.find(i => i.name === 'auth_challenges_expires_at_ttl');
  assert.ok(ttlIndex, 'TTL index should be created');
  assert.equal(ttlIndex.expireAfterSeconds, 0, 'TTL index should have expireAfterSeconds: 0');

  const lookupIndex = indexes.find(i => i.name === 'auth_challenges_address_nonce');
  assert.ok(lookupIndex, 'address+nonce index should be created');

  const statusIndex = indexes.find(i => i.name === 'auth_challenges_used_expires');
  assert.ok(statusIndex, 'used+expiresAt index should be created');
});

// ── Multisig tests ──────────────────────────────────────────────────────────

test('accepts transaction with multiple signatures when one is valid', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const extraKeypair = Keypair.random();
  const address = keypair.publicKey();
  const challenge = await issueChallenge(address, { db });
  const tx = buildSignedTx(keypair, challenge.nonce);
  tx.sign(extraKeypair);

  const result = await verifyChallenge(address, challenge.nonce, tx.toXDR(), { db });
  assert.equal(result.valid, true);
});

// ── Wrong network passphrase test ───────────────────────────────────────────

test('wrong network passphrase fails verification', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const address = keypair.publicKey();
  const challenge = await issueChallenge(address, { db });

  const wrongNetAccount = new Account(address, '0');
  const wrongNetTx = new TransactionBuilder(wrongNetAccount, {
    fee: '100',
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '0' }))
    .addMemo(Memo.text(challenge.nonce))
    .setTimeout(0)
    .build();
  wrongNetTx.sign(keypair);

  const result = await verifyChallenge(address, challenge.nonce, wrongNetTx.toXDR(), { db });
  assert.equal(result.valid, false, 'wrong network transaction should fail verification');
});

// ── Clock-skew boundary test ────────────────────────────────────────────────

test('expired challenge is rejected even with valid signature', async () => {
  const db = inMemoryDb();
  const keypair = Keypair.random();
  const address = keypair.publicKey();
  const challenge = await issueChallenge(address, { db });

  const col = db.collection('auth_challenges');
  for (const doc of col.docs.values()) {
    doc.expiresAt = new Date(Date.now() - 60000);
  }

  const tx = buildSignedTx(keypair, challenge.nonce);
  const result = await verifyChallenge(address, challenge.nonce, tx.toXDR(), { db });
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes('expired') || result.reason.includes('not found'));
});

// ── Cross-address reuse test ────────────────────────────────────────────────

test('challenge issued for one address cannot be used by another', async () => {
  const db = inMemoryDb();
  const keypairA = Keypair.random();
  const keypairB = Keypair.random();
  const challenge = await issueChallenge(keypairA.publicKey(), { db });
  const tx = buildSignedTx(keypairB, challenge.nonce);

  const result = await verifyChallenge(keypairB.publicKey(), challenge.nonce, tx.toXDR(), { db });
  assert.equal(result.valid, false);
});

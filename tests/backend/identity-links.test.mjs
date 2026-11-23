/**
 * Deterministic external identity linking and unlinking (#880).
 *
 * Runs against a real MongoDB (mongodb-memory-server) with the indexes
 * declared in REQUIRED_INDEXES, so the "linked once" partial unique index,
 * single-use challenges and audit ledger behave exactly as in production.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Keypair } from '@stellar/stellar-sdk';

import {
  IDENTITY_CHALLENGE_TTL_MS,
  confirmIdentityLink,
  createIdentityLinkChallenge,
  findLinkedAccountId,
  listIdentityLinks,
  sep53MessageHash,
  unlinkIdentity,
  verifySep53Signature,
} from '../../src/lib/auth/identityLinks.js';
import { REQUIRED_INDEXES } from '../../src/lib/backend/schemaContracts.js';

const NOW = new Date('2026-10-20T12:00:00.000Z');

let mongod;
let client;
let db;
let alice;
let bob;

const sign = (keypair, message) => keypair.sign(sep53MessageHash(message)).toString('base64');

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function ledger(action) {
  return db.collection('audit_ledger').find({ action }).toArray();
}

async function link(user, keypair, now = NOW) {
  const challenge = await createIdentityLinkChallenge({ db, user, provider: 'stellar', subject: keypair.publicKey(), now });
  return confirmIdentityLink({ db, user, challengeId: challenge.challengeId, signature: sign(keypair, challenge.message), now });
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('identity_links_test');
});

after(async () => {
  await client.close();
  await mongod.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  for (const name of ['identity_links', 'identity_link_challenges', 'audit_ledger']) {
    for (const { keys, options } of REQUIRED_INDEXES[name]) await db.collection(name).createIndex(keys, options);
  }
  alice = { _id: new ObjectId(), walletAddress: Keypair.random().publicKey(), sessionVersion: 1 };
  bob = { _id: new ObjectId(), walletAddress: Keypair.random().publicKey(), sessionVersion: 1 };
  await db.collection('users').insertMany([alice, bob]);
});

describe('SEP-53 verification', () => {
  // Official vectors from stellar-protocol ecosystem/sep-0053.md.
  const address = 'GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L';

  it('accepts the specification test vectors', () => {
    assert.ok(
      verifySep53Signature({
        publicKey: address,
        message: 'Hello, World!',
        signature: 'fO5dbYhXUhBMhe6kId/cuVq/AfEnHRHEvsP8vXh03M1uLpi5e46yO2Q8rEBzu3feXQewcQE5GArp88u6ePK6BA==',
      })
    );
    assert.ok(
      verifySep53Signature({
        publicKey: address,
        message: 'こんにちは、世界！',
        signature: 'CDU265Xs8y3OWbB/56H9jPgUss5G9A0qFuTqH2zs2YDgTm+++dIfmAEceFqB7bhfN3am59lCtDXrCtwH2k1GBA==',
      })
    );
  });

  it('rejects a tampered message, a wrong key and malformed signatures', () => {
    const signature = 'fO5dbYhXUhBMhe6kId/cuVq/AfEnHRHEvsP8vXh03M1uLpi5e46yO2Q8rEBzu3feXQewcQE5GArp88u6ePK6BA==';
    assert.equal(verifySep53Signature({ publicKey: address, message: 'Hello, World?', signature }), false);
    assert.equal(verifySep53Signature({ publicKey: Keypair.random().publicKey(), message: 'Hello, World!', signature }), false);
    assert.equal(verifySep53Signature({ publicKey: address, message: 'Hello, World!', signature: 'not-a-signature' }), false);
  });
});

describe('link', () => {
  it('links a verified identity, exposes it to the owner and audits it', async () => {
    const identity = Keypair.random();
    const challenge = await createIdentityLinkChallenge({ db, user: alice, provider: 'stellar', subject: identity.publicKey(), now: NOW });

    assert.match(challenge.message, /^EduVault identity link\n/);
    assert.ok(challenge.message.includes(`Account: ${alice._id}`), 'signature is bound to the requesting account');

    const linked = await confirmIdentityLink({
      db,
      user: alice,
      challengeId: challenge.challengeId,
      signature: sign(identity, challenge.message),
      now: NOW,
    });

    assert.equal(linked.subject, identity.publicKey());
    assert.deepEqual((await listIdentityLinks({ db, user: alice })).map((l) => l.linkId), [linked.linkId]);
    assert.equal(await findLinkedAccountId({ db, provider: 'stellar', subject: identity.publicKey() }), String(alice._id));

    const [entry] = await ledger('identity.linked');
    assert.equal(entry.actor, String(alice._id));
    assert.deepEqual(entry.target, { type: 'user', id: String(alice._id) });
    assert.equal(entry.result.linkId, linked.linkId);
  });

  it('accepts a lower-cased address as the same canonical identity', async () => {
    const identity = Keypair.random();
    const challenge = await createIdentityLinkChallenge({
      db,
      user: alice,
      provider: 'stellar',
      subject: identity.publicKey().toLowerCase(),
      now: NOW,
    });
    assert.equal(challenge.subject, identity.publicKey());
  });

  it('rejects a duplicate link to the same account', async () => {
    const identity = Keypair.random();
    await link(alice, identity);
    await expectCode(
      createIdentityLinkChallenge({ db, user: alice, provider: 'stellar', subject: identity.publicKey(), now: NOW }),
      'DUPLICATE_LINK'
    );
  });

  it('rejects an identity linked to, or the primary wallet of, another account', async () => {
    const identity = Keypair.random();
    await link(alice, identity);
    await expectCode(
      createIdentityLinkChallenge({ db, user: bob, provider: 'stellar', subject: identity.publicKey(), now: NOW }),
      'IDENTITY_ALREADY_LINKED'
    );
    await expectCode(
      createIdentityLinkChallenge({ db, user: bob, provider: 'stellar', subject: alice.walletAddress, now: NOW }),
      'IDENTITY_ALREADY_LINKED'
    );
    await expectCode(
      createIdentityLinkChallenge({ db, user: alice, provider: 'stellar', subject: alice.walletAddress, now: NOW }),
      'PRIMARY_IDENTITY'
    );
  });

  it('rejects unsupported providers and invalid subjects', async () => {
    await expectCode(createIdentityLinkChallenge({ db, user: alice, provider: 'github', subject: 'x', now: NOW }), 'UNSUPPORTED_PROVIDER');
    await expectCode(createIdentityLinkChallenge({ db, user: alice, provider: 'stellar', subject: 'GNOTAKEY', now: NOW }), 'INVALID_SUBJECT');
  });

  it('enforces the per-account link limit', async () => {
    for (let i = 0; i < 5; i += 1) await link(alice, Keypair.random());
    await expectCode(
      createIdentityLinkChallenge({ db, user: alice, provider: 'stellar', subject: Keypair.random().publicKey(), now: NOW }),
      'LINK_LIMIT_REACHED'
    );
  });

  it('links an identity to exactly one account when two accounts race for it', async () => {
    const identity = Keypair.random();
    const [a, b] = await Promise.all(
      [alice, bob].map((user) => createIdentityLinkChallenge({ db, user, provider: 'stellar', subject: identity.publicKey(), now: NOW }))
    );
    const results = await Promise.allSettled([
      confirmIdentityLink({ db, user: alice, challengeId: a.challengeId, signature: sign(identity, a.message), now: NOW }),
      confirmIdentityLink({ db, user: bob, challengeId: b.challengeId, signature: sign(identity, b.message), now: NOW }),
    ]);

    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'IDENTITY_ALREADY_LINKED');
    assert.equal(await db.collection('identity_links').countDocuments({ status: 'linked' }), 1);
  });
});

describe('failed verification', () => {
  it('rejects a signature from another key, burns the challenge and audits the attempt', async () => {
    const identity = Keypair.random();
    const challenge = await createIdentityLinkChallenge({ db, user: alice, provider: 'stellar', subject: identity.publicKey(), now: NOW });

    await expectCode(
      confirmIdentityLink({ db, user: alice, challengeId: challenge.challengeId, signature: sign(Keypair.random(), challenge.message), now: NOW }),
      'VERIFICATION_FAILED'
    );
    // The correct signature can no longer use the burned challenge.
    await expectCode(
      confirmIdentityLink({ db, user: alice, challengeId: challenge.challengeId, signature: sign(identity, challenge.message), now: NOW }),
      'CHALLENGE_INVALID'
    );

    assert.equal(await db.collection('identity_links').countDocuments(), 0);
    assert.equal((await ledger('identity.link_failed')).length, 1);
  });

  it('rejects expired challenges and challenges issued to another account', async () => {
    const identity = Keypair.random();
    const expired = await createIdentityLinkChallenge({ db, user: alice, provider: 'stellar', subject: identity.publicKey(), now: NOW });
    await expectCode(
      confirmIdentityLink({
        db,
        user: alice,
        challengeId: expired.challengeId,
        signature: sign(identity, expired.message),
        now: new Date(NOW.getTime() + IDENTITY_CHALLENGE_TTL_MS + 1),
      }),
      'CHALLENGE_INVALID'
    );

    const aliceChallenge = await createIdentityLinkChallenge({ db, user: alice, provider: 'stellar', subject: identity.publicKey(), now: NOW });
    await expectCode(
      confirmIdentityLink({ db, user: bob, challengeId: aliceChallenge.challengeId, signature: sign(identity, aliceChallenge.message), now: NOW }),
      'CHALLENGE_INVALID'
    );
  });
});

describe('unlink and relink', () => {
  beforeEach(async () => {
    await db.collection('refresh_tokens').insertMany([
      { userId: String(alice._id), sessionFamilyId: 'fam-current', revoked: false },
      { userId: String(alice._id), sessionFamilyId: 'fam-other', revoked: false },
    ]);
  });

  it('unlinks, removes access through the identity, revokes other sessions and audits it', async () => {
    const identity = Keypair.random();
    const linked = await link(alice, identity);
    const pending = await createIdentityLinkChallenge({
      db,
      user: bob,
      provider: 'stellar',
      subject: Keypair.random().publicKey(),
      now: NOW,
    });

    const result = await unlinkIdentity({ db, user: alice, linkId: linked.linkId, sessionFamilyId: 'fam-current', now: NOW });

    assert.equal(result.status, 'unlinked');
    assert.equal(await findLinkedAccountId({ db, provider: 'stellar', subject: identity.publicKey() }), null);
    assert.deepEqual(await listIdentityLinks({ db, user: alice }), []);

    const user = await db.collection('users').findOne({ _id: alice._id });
    assert.equal(user.sessionVersion, 2, 'access tokens issued before the unlink are stale');
    const tokens = await db.collection('refresh_tokens').find({}).sort({ sessionFamilyId: 1 }).toArray();
    assert.deepEqual(tokens.map((t) => [t.sessionFamilyId, t.revoked]), [['fam-current', false], ['fam-other', true]]);

    assert.equal((await ledger('identity.unlinked')).length, 1);
    // Unrelated pending challenges are untouched.
    assert.equal((await db.collection('identity_link_challenges').findOne({ challengeId: pending.challengeId })).status, 'pending');
  });

  it('burns a challenge issued before the unlink so it cannot silently relink', async () => {
    const identity = Keypair.random();
    const used = await createIdentityLinkChallenge({ db, user: alice, provider: 'stellar', subject: identity.publicKey(), now: NOW });
    const stale = await createIdentityLinkChallenge({ db, user: alice, provider: 'stellar', subject: identity.publicKey(), now: NOW });
    const linked = await confirmIdentityLink({ db, user: alice, challengeId: used.challengeId, signature: sign(identity, used.message), now: NOW });

    await unlinkIdentity({ db, user: alice, linkId: linked.linkId, now: NOW });
    await expectCode(
      confirmIdentityLink({ db, user: alice, challengeId: stale.challengeId, signature: sign(identity, stale.message), now: NOW }),
      'CHALLENGE_INVALID'
    );
  });

  it('relinks with a fresh proof and keeps the earlier link as history', async () => {
    const identity = Keypair.random();
    const first = await link(alice, identity);
    await unlinkIdentity({ db, user: alice, linkId: first.linkId, now: NOW });

    const second = await link(alice, identity);

    assert.notEqual(second.linkId, first.linkId);
    assert.equal(await findLinkedAccountId({ db, provider: 'stellar', subject: identity.publicKey() }), String(alice._id));
    const rows = await db.collection('identity_links').find({ subjectKey: identity.publicKey() }).toArray();
    assert.deepEqual(rows.map((r) => r.status).sort(), ['linked', 'unlinked']);
  });

  it('lets another account link the identity after it was unlinked', async () => {
    const identity = Keypair.random();
    const first = await link(alice, identity);
    await unlinkIdentity({ db, user: alice, linkId: first.linkId, now: NOW });
    await link(bob, identity);
    assert.equal(await findLinkedAccountId({ db, provider: 'stellar', subject: identity.publicKey() }), String(bob._id));
  });

  it("refuses to unlink another account's identity without revealing it and audits the attempt", async () => {
    const identity = Keypair.random();
    const linked = await link(alice, identity);

    await expectCode(unlinkIdentity({ db, user: bob, linkId: linked.linkId, now: NOW }), 'LINK_NOT_FOUND');
    await expectCode(unlinkIdentity({ db, user: bob, linkId: 'missing', now: NOW }), 'LINK_NOT_FOUND');

    assert.equal(await findLinkedAccountId({ db, provider: 'stellar', subject: identity.publicKey() }), String(alice._id));
    assert.equal((await db.collection('users').findOne({ _id: alice._id })).sessionVersion, 1);
    const denied = await ledger('identity.unlink_denied');
    assert.equal(denied.length, 1, 'only the attempt on an existing foreign link is audited');
    assert.equal(denied[0].actor, String(bob._id));
  });

  it('restores the link when session revocation fails, so a retry re-runs it', async () => {
    const linked = await link(alice, Keypair.random());
    const failingRevoke = async () => {
      throw new Error('revocation store unavailable');
    };

    await assert.rejects(unlinkIdentity({ db, user: alice, linkId: linked.linkId, now: NOW, revokeSessions: failingRevoke }));
    assert.equal((await db.collection('identity_links').findOne({ linkId: linked.linkId })).status, 'linked');

    await unlinkIdentity({ db, user: alice, linkId: linked.linkId, now: NOW });
    assert.equal((await db.collection('identity_links').findOne({ linkId: linked.linkId })).status, 'unlinked');
  });
});

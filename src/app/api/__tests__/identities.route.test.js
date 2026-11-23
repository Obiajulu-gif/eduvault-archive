// @vitest-environment node
//
// #880: HTTP wiring for /api/identities. Domain rules are covered in
// tests/backend/identity-links.test.mjs; this checks authentication,
// request/response shapes and problem-details error mapping.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { MongoClient, ObjectId } from 'mongodb';

const { currentAuth, database } = vi.hoisted(() => ({ currentAuth: { value: null }, database: { db: null } }));

// The global setup mocks @/lib/mongodb with fixed fakes; these routes need real
// query semantics, so use the in-memory server started by global-setup-outbox.js.
vi.mock('@/lib/mongodb', () => ({ getDb: vi.fn(async () => database.db) }));
// Also globally mocked; link/unlink must write real audit records.
vi.mock('@/lib/backend/auditLedger', async (importOriginal) => importOriginal());

vi.mock('@/lib/api/auth', () => ({
  requireActiveUser: vi.fn(async () => currentAuth.value),
}));
vi.mock('@/lib/api/hardening', () => ({
  withApiHardening: vi.fn((req, options, handler) => handler()),
}));

import { sep53MessageHash } from '@/lib/auth/identityLinks';
import { GET as listLinks, POST as confirmLink } from '../identities/route';
import { POST as requestChallenge } from '../identities/challenge/route';
import { DELETE as unlink } from '../identities/[linkId]/route';

const post = (url, body) =>
  new Request(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const del = (url) => new Request(`http://localhost${url}`, { method: 'DELETE' });
const get = (url) => new Request(`http://localhost${url}`, { method: 'GET' });

const alice = { _id: new ObjectId(), walletAddress: Keypair.random().publicKey(), sessionFamilyId: 'fam-current' };
const bob = { _id: new ObjectId(), walletAddress: Keypair.random().publicKey() };
const as = (user) => {
  currentAuth.value = { ok: true, user };
};

let client;
let db;

beforeAll(async () => {
  client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db('identities_route_test');
  database.db = db;
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  for (const name of ['identity_links', 'identity_link_challenges', 'audit_ledger', 'users', 'refresh_tokens']) {
    await db.collection(name).deleteMany({});
  }
  await db.collection('users').insertMany([
    { _id: alice._id, walletAddress: alice.walletAddress, sessionVersion: 1 },
    { _id: bob._id, walletAddress: bob.walletAddress, sessionVersion: 1 },
  ]);
});

async function linkViaApi(identity) {
  const challengeResponse = await requestChallenge(post('/api/identities/challenge', { provider: 'stellar', subject: identity.publicKey() }));
  expect(challengeResponse.status).toBe(201);
  const challenge = await challengeResponse.json();
  const signature = identity.sign(sep53MessageHash(challenge.message)).toString('base64');
  return confirmLink(post('/api/identities', { challengeId: challenge.challengeId, signature }));
}

describe('/api/identities', () => {
  it('requires an active session', async () => {
    currentAuth.value = { ok: false, status: 401 };
    expect((await listLinks(get('/api/identities'))).status).toBe(401);
    expect((await requestChallenge(post('/api/identities/challenge', {}))).status).toBe(401);
  });

  it('links, lists and unlinks an identity', async () => {
    as(alice);
    const identity = Keypair.random();

    const linkResponse = await linkViaApi(identity);
    expect(linkResponse.status).toBe(201);
    const { link } = await linkResponse.json();
    expect(link.subject).toBe(identity.publicKey());

    const listed = await (await listLinks(get('/api/identities'))).json();
    expect(listed.links.map((l) => l.linkId)).toEqual([link.linkId]);

    const unlinkResponse = await unlink(del(`/api/identities/${link.linkId}`), { params: Promise.resolve({ linkId: link.linkId }) });
    expect(unlinkResponse.status).toBe(200);
    expect((await unlinkResponse.json()).status).toBe('unlinked');
    expect((await (await listLinks(get('/api/identities'))).json()).links).toEqual([]);
  });

  it('maps domain errors to problem details with a stable type', async () => {
    as(alice);
    const identity = Keypair.random();
    await linkViaApi(identity);

    const duplicate = await requestChallenge(post('/api/identities/challenge', { provider: 'stellar', subject: identity.publicKey() }));
    expect(duplicate.status).toBe(409);
    expect(duplicate.headers.get('content-type')).toContain('application/problem+json');
    expect((await duplicate.json()).type).toBe('https://eduvault.dev/problems/duplicate_link');

    const badSignature = await confirmLink(post('/api/identities', { challengeId: 'unknown', signature: 'x' }));
    expect(badSignature.status).toBe(409);
    expect((await badSignature.json()).type).toBe('https://eduvault.dev/problems/challenge_invalid');
  });

  it("returns 404 when unlinking another account's identity", async () => {
    as(alice);
    const { link } = await (await linkViaApi(Keypair.random())).json();

    as(bob);
    const response = await unlink(del(`/api/identities/${link.linkId}`), { params: Promise.resolve({ linkId: link.linkId }) });
    expect(response.status).toBe(404);
    expect((await response.json()).type).toBe('https://eduvault.dev/problems/link_not_found');
  });
});

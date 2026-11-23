// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { fakeDb } from '../../../../../tests/fixtures/trustDb.mjs';
import { POST } from './route';
const mocks = vi.hoisted(() => ({ db: null, user: null }));
vi.mock('@/lib/mongodb', () => ({ getDb: async () => mocks.db }));
vi.mock('@/lib/api/auth', () => ({ requireActiveUser: async () => ({ ok: true, user: mocks.user }) }));
vi.mock('@/lib/api/hardening', () => ({ withApiHardening: async (_request, _options, handler) => handler() }));
let wallet;
beforeEach(() => {
  mocks.db = fakeDb();
  wallet = Keypair.random();
  mocks.user = { sub: 'student', walletAddress: wallet.publicKey() };
});
const post = body => POST(new Request('https://eduvault.test/api/verification/step-up', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));
const start = async () => (await post({ binding: { target: 'asset', action: 'delete', version: 1, deleted: false } })).json();
it('verifies a real linked-wallet signature over the exact challenge bytes', async () => {
  const challenge = await start();
  const signature = wallet.sign(Buffer.from(challenge.message, 'utf8')).toString('base64');
  expect(await (await post({ id: challenge.id, signature })).json()).toMatchObject({ state: 'verified' });
  expect((await post({ id: challenge.id, signature })).status).toBe(409);
});
it('rejects signatures from another wallet and prevents cross-account completion', async () => {
  const challenge = await start();
  const signature = Keypair.random().sign(Buffer.from(challenge.message)).toString('base64');
  expect(await (await post({ id: challenge.id, signature })).json()).toMatchObject({ state: 'failed' });
  const another = await start();
  mocks.user = { ...mocks.user, sub: 'outsider' };
  expect((await post({ id: another.id, signature })).status).toBe(404);
});

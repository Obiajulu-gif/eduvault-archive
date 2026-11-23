import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from '../fixtures/trustDb.mjs';
import { actionBinding, requireFraudReview, resolveFraudReview } from '../../src/lib/backend/fraudReview.js';
import { appendCaseEvent, createCase, readCase, verifyTimeline } from '../../src/lib/backend/supportTimeline.js';
import { requireStepUp, startStepUp, verifyStepUp } from '../../src/lib/backend/stepUpVerification.js';
const admin = { sub: 'admin', role: 'admin' };
test('concurrent duplicate queue and conflicting decisions have one winner', async () => {
  const db = fakeDb(), user = { sub: 'student', securityReviewRequired: true };
  const args = { db, user, material: { _id: 'asset' }, action: 'delete' };
  const [first, second] = await Promise.all([requireFraudReview(args), requireFraudReview(args)]);
  assert.equal(first.reviewId, second.reviewId);
  assert.equal(db.collection('fraud_reviews').rows.length, 1);
  const results = await Promise.allSettled(['approved', 'rejected'].map(decision => resolveFraudReview({
    db, user: admin, id: first.reviewId, decision, reason: 'investigated',
  })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(db.collection('fraud_reviews').rows[0].history.length, 2);
});
test('concurrent support appends preserve a verifiable chain and allow retry', async () => {
  const db = fakeDb();
  const { id } = await createCase({ db, user: admin, summary: 'Storage incident' });
  const args = { db, user: admin, id, type: 'note', content: 'investigating' };
  const results = await Promise.allSettled([appendCaseEvent(args), appendCaseEvent(args)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await appendCaseEvent(args);
  const record = await readCase(args);
  assert.equal(record.events.length, 3);
  assert.ok(verifyTimeline(record));
});
test('concurrent uses consume a verified grant only once', async () => {
  const db = fakeDb(), user = { sub: 'student', walletAddress: 'Glinked', stepUpRequired: true };
  const material = { _id: 'asset' }, action = 'delete';
  const { id } = await startStepUp({ db, user, binding: actionBinding(user, material, action) });
  await verifyStepUp({ db, user, id, signature: 'proof', verifySignature: () => true });
  const args = { db, user, material, action, verificationId: id };
  const results = await Promise.all([requireStepUp(args), requireStepUp(args)]);
  assert.equal(results.filter(r => r.allowed).length, 1);
});

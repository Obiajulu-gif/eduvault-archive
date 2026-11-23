import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendCaseEvent, createCase, readCase, verifyTimeline } from '../../src/lib/backend/supportTimeline.js';
import { fakeDb } from '../fixtures/trustDb.mjs';
test('case creation, notes, escalation, evidence, resolution and visibility', async () => {
  const db = fakeDb(), user = { sub: 'student' }, admin = { sub: 'maintainer', role: 'admin' };
  const { id } = await createCase({ db, user, summary: 'Purchased file unavailable' });
  const args = { db, user: admin, id };
  await appendCaseEvent({ ...args, type: 'note', content: 'internal investigation', visibility: 'private' });
  await appendCaseEvent({ ...args, type: 'evidence', content: 'redacted receipt reference', visibility: 'private' });
  await appendCaseEvent({ ...args, type: 'escalation', content: 'Storage team investigating' });
  await assert.rejects(appendCaseEvent({ ...args, user, type: 'note', content: 'hidden', visibility: 'private' }));
  await assert.rejects(readCase({ ...args, user: { sub: 'outsider' } }));
  await appendCaseEvent({ ...args, type: 'resolution', content: 'Access restored' });
  const safe = await readCase({ ...args, user });
  assert.equal(safe.state, 'resolved');
  assert.equal(safe.events.length, 3);
  assert.ok(!JSON.stringify(safe).includes('internal investigation'));
  const full = await readCase(args);
  assert.equal(full.events.length, 5);
  assert.ok(verifyTimeline(full));
  await assert.rejects(appendCaseEvent({ ...args, type: 'note', content: 'late note' }));
});
test('detect mutation, removal, reordering and truncation', async () => {
  const db = fakeDb(), user = { sub: 'student' };
  const { id } = await createCase({ db, user, summary: 'Help' });
  await appendCaseEvent({ db, user, id, type: 'note', content: 'Details' });
  const record = db.collection('support_cases').rows[0];
  for (const mutate of [r => { r.events[0].content = 'edited'; }, r => r.events.reverse(), r => r.events.pop()]) {
    const copy = structuredClone(record); mutate(copy); assert.equal(verifyTimeline(copy), false);
  }
  record.events[0].actor = 'forged';
  await assert.rejects(readCase({ db, user, id }), /TIMELINE_INTEGRITY_FAILURE/);
});

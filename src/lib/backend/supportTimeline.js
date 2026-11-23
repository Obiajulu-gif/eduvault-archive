import { randomUUID } from 'node:crypto';
import { actorId, digest, maintainer, text, TrustError } from './trustRecords.js';

const TYPES = ['status', 'note', 'evidence', 'escalation', 'resolution'];
export function verifyTimeline(record) {
  let previous = 'genesis';
  for (const [index, event] of record.events.entries()) {
    const { hash, ...payload } = event;
    if (event.sequence !== index + 1 || event.previous !== previous || digest(payload) !== hash) return false;
    previous = hash;
  }
  return record.revision === record.events.length && record.head === previous;
}
function authorize(record, user) {
  if (record.owner !== actorId(user) && user.role !== 'admin') throw new TrustError('NOT_FOUND', 404);
}
function eventFor(record, actor, type, content, visibility) {
  const payload = { caseId: record._id, sequence: record.revision + 1, previous: record.head,
    actor, type, content, visibility, at: new Date().toISOString() };
  return { ...payload, hash: digest(payload) };
}
export async function createCase({ db, user, summary }) {
  const owner = actorId(user);
  const record = { _id: randomUUID(), owner, state: 'open', revision: 0, head: 'genesis', events: [] };
  const event = eventFor(record, owner, 'status', text(summary, 2000), 'user');
  record.events.push(event); record.revision = 1; record.head = event.hash;
  await db.collection('support_cases').insertOne(record);
  return { id: record._id, state: record.state };
}
export async function appendCaseEvent({ db, user, id, type, content, visibility = 'user' }) {
  const record = await db.collection('support_cases').findOne({ _id: text(id) });
  if (!record) throw new TrustError('NOT_FOUND', 404);
  authorize(record, user);
  if (!verifyTimeline(record)) throw new TrustError('TIMELINE_INTEGRITY_FAILURE');
  if (!TYPES.includes(type) || !['user', 'private'].includes(visibility)) throw new TrustError('INVALID_EVENT', 400);
  if (type !== 'note' || visibility === 'private') maintainer(user);
  if (record.state === 'resolved') throw new TrustError('CASE_RESOLVED');
  const event = eventFor(record, actorId(user), type, text(content, 2000), visibility);
  const state = type === 'resolution' ? 'resolved' : type === 'escalation' ? 'escalated' : record.state;
  const result = await db.collection('support_cases').updateOne({ _id: id, revision: record.revision, head: record.head },
    { $set: { revision: record.revision + 1, head: event.hash, state }, $push: { events: event } });
  if (!result.modifiedCount) throw new TrustError('TIMELINE_CONCURRENT_UPDATE');
  return { id, state };
}
export async function readCase({ db, user, id }) {
  const record = await db.collection('support_cases').findOne({ _id: text(id) });
  if (!record) throw new TrustError('NOT_FOUND', 404);
  authorize(record, user);
  if (!verifyTimeline(record)) throw new TrustError('TIMELINE_INTEGRITY_FAILURE');
  if (user.role === 'admin') return record;
  // Hashes and original sequence numbers could reveal private note metadata.
  return { id: record._id, state: record.state, events: record.events.filter(e => e.visibility === 'user')
    .map(e => ({ type: e.type, content: e.content, actor: e.actor, at: e.at })) };
}

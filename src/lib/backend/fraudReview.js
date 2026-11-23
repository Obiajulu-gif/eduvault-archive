import { actorId, digest, insertOnce, maintainer, text, TrustError } from './trustRecords.js';

// Signals are derived from persisted account/material state, never request headers.
export function fraudSignals({ user, material }) {
  return [user.securityReviewRequired === true && 'ACCOUNT_SECURITY_REVIEW',
    material?.status === 'quarantined' && 'QUARANTINED_ASSET',
    material?.fraudHold === true && 'ASSET_FRAUD_HOLD'].filter(Boolean).sort();
}
export function actionBinding(user, material, action) {
  return { actor: actorId(user), target: String(material._id), action,
    version: material.searchVersion ?? 0, deleted: Boolean(material.isDeleted) };
}
export async function requireFraudReview({ db, user, material, action }) {
  const binding = actionBinding(user, material, action);
  const reasons = fraudSignals({ user, material });
  const id = digest({ binding, reasons });
  const collection = db.collection('fraud_reviews');
  // An existing rejection remains binding even if the triggering flag is cleared.
  const bindingHash = digest(binding);
  const rejected = await collection.findOne({ bindingHash, state: 'rejected' });
  if (rejected) return { allowed: false, reviewId: rejected._id, state: 'rejected' };
  const pending = await collection.findOne({ bindingHash, state: 'pending' });
  if (pending) return { allowed: false, reviewId: pending._id, state: 'pending' };
  const review = await collection.findOne({ _id: id });
  if (review?.state === 'approved') return { allowed: true, reviewId: id };
  if (review) return { allowed: false, reviewId: id, state: review.state };
  if (!reasons.length) return { allowed: true };
  const record = await insertOnce(collection, { _id: id, binding, bindingHash, reasons, state: 'pending', createdAt: new Date().toISOString(),
    evidence: { materialStatus: String(material.status || 'unknown'), signals: reasons },
    history: [{ state: 'pending', actor: binding.actor, at: new Date().toISOString() }] });
  return { allowed: record.state === 'approved', reviewId: id, state: record.state };
}
export async function resolveFraudReview({ db, user, id, decision, reason }) {
  const actor = maintainer(user);
  if (!['approved', 'rejected'].includes(decision)) throw new TrustError('INVALID_DECISION', 400);
  const collection = db.collection('fraud_reviews');
  const review = await collection.findOne({ _id: text(id) });
  if (!review) throw new TrustError('NOT_FOUND', 404);
  if (review.binding.actor === actor) throw new TrustError('SELF_REVIEW_FORBIDDEN', 403);
  const event = { state: decision, actor, reason: text(reason), at: new Date().toISOString() };
  const result = await collection.updateOne({ _id: id, state: 'pending' },
    { $set: { state: decision }, $push: { history: event } });
  if (!result.modifiedCount) throw new TrustError('REVIEW_ALREADY_RESOLVED');
  return { state: decision };
}

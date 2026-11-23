import { randomUUID } from 'node:crypto';
import { actionBinding } from './fraudReview.js';
import { actorId, digest, text, TrustError } from './trustRecords.js';

export const STEP_UP_TTL_MS = 5 * 60 * 1000;
export function riskSignals({ user, material, action }) {
  return [user.securityReviewRequired === true && 'ACCOUNT_SECURITY_REVIEW',
    user.stepUpRequired === true && 'ACCOUNT_VERIFICATION_REQUIRED',
    material?.fraudHold === true && 'ASSET_FRAUD_HOLD',
    action === 'restore' && material?.status === 'quarantined' && 'QUARANTINED_RESTORE'].filter(Boolean).sort();
}
export async function requireStepUp({ db, user, material, action, verificationId, now = Date.now() }) {
  if (!riskSignals({ user, material, action }).length) return { allowed: true };
  if (verificationId) {
    const record = await db.collection('step_up_verifications').findOne({ _id: text(verificationId) });
    const bindingHash = digest(actionBinding(user, material, action));
    if (record?.actor === actorId(user) && record.bindingHash === bindingHash && record.state === 'verified' && record.expiresAt > now) {
      const result = await db.collection('step_up_verifications').updateOne({ _id: record._id, state: 'verified' },
        { $set: { state: 'consumed', consumedAt: now } });
      if (result.modifiedCount) return { allowed: true };
    }
  }
  return { allowed: false, code: 'STEP_UP_REQUIRED', explanation: 'Confirm this action with your linked wallet.',
    retry: '/api/verification/step-up' };
}
export async function startStepUp({ db, user, binding, now = Date.now() }) {
  if (!user.walletAddress?.startsWith('G')) throw new TrustError('LINKED_STELLAR_WALLET_REQUIRED', 400);
  const actor = actorId(user);
  if (!['delete', 'restore'].includes(binding.action)) throw new TrustError('INVALID_ACTION', 400);
  const normalized = { actor, target: text(binding.target), action: binding.action,
    version: binding.version, deleted: binding.deleted };
  if (!Number.isSafeInteger(normalized.version) || typeof normalized.deleted !== 'boolean') throw new TrustError('INVALID_BINDING', 400);
  const bindingHash = digest(normalized);
  const record = { _id: randomUUID(), actor, wallet: user.walletAddress, bindingHash,
    state: 'pending', expiresAt: now + STEP_UP_TTL_MS, createdAt: now };
  record.message = `EduVault step-up v1\n${record._id}\n${actor}\n${bindingHash}\n${record.expiresAt}`;
  await db.collection('step_up_verifications').insertOne(record);
  return { id: record._id, message: record.message, expiresAt: record.expiresAt };
}
export async function verifyStepUp({ db, user, id, signature, verifySignature, now = Date.now() }) {
  const collection = db.collection('step_up_verifications');
  const record = await collection.findOne({ _id: text(id) });
  if (!record || record.actor !== actorId(user) || record.wallet !== user.walletAddress) throw new TrustError('NOT_FOUND', 404);
  if (record.state !== 'pending') throw new TrustError('VERIFICATION_ALREADY_USED');
  let state = 'expired';
  if (record.expiresAt > now) {
    let valid = false;
    try { valid = await verifySignature(record.wallet, record.message, text(signature, 200)); } catch { /* Invalid signatures fail closed. */ }
    state = valid === true ? 'verified' : 'failed';
  }
  const result = await collection.updateOne({ _id: id, state: 'pending' }, { $set: { state, decidedAt: now } });
  if (!result.modifiedCount) throw new TrustError('VERIFICATION_ALREADY_USED');
  return { state, retry: state === 'verified' ? null : '/api/verification/step-up' };
}

import { actorId, digest, insertOnce, text, TrustError } from './trustRecords.js';

// Published text is immutable. Changes require a NEW version and deployment.
export const POLICIES = Object.freeze({
  'catalog-management:1': Object.freeze({ id: 'catalog-management', version: '1',
    content: 'Catalog retirement hides listings but preserves purchased learning assets and audit records.' }),
});
export const REQUIRED_CONSENT = Object.freeze({ 'material.manage': 'catalog-management:1' });

export async function recordConsent({ db, user, policyKey, versionHash, decision, source = 'account-api' }) {
  const actor = actorId(user);
  const policy = Object.hasOwn(POLICIES, policyKey) ? POLICIES[policyKey] : null;
  if (!policy || versionHash !== digest(policy)) throw new TrustError('POLICY_VERSION_MISMATCH', 400);
  if (!['accepted', 'revoked'].includes(decision)) throw new TrustError('INVALID_DECISION', 400);
  const published = await insertOnce(db.collection('consent_policy_versions'),
    { _id: policyKey, policy, versionHash });
  if (published.versionHash !== versionHash) throw new TrustError('POLICY_CONTENT_CHANGED');
  const collection = db.collection('consent_ledgers');
  const id = digest({ actor, policyKey });
  const ledger = await insertOnce(collection, { _id: id, actor, policy, versionHash, revision: 0, events: [] });
  if (ledger.versionHash !== versionHash) throw new TrustError('POLICY_CONTENT_CHANGED');
  const event = { decision, actor, at: new Date().toISOString(), source: text(source, 100),
    version: policy.version, versionHash };
  const result = await collection.updateOne({ _id: id, revision: ledger.revision },
    { $set: { revision: ledger.revision + 1, decision }, $push: { events: event } });
  if (!result.modifiedCount) throw new TrustError('CONSENT_CONCURRENT_UPDATE');
  return event;
}
export async function requireConsent({ db, user, flow }) {
  const policyKey = REQUIRED_CONSENT[flow];
  if (!policyKey) throw new TrustError('UNKNOWN_CONSENT_FLOW', 400);
  const actor = actorId(user);
  const ledger = await db.collection('consent_ledgers').findOne({ _id: digest({ actor, policyKey }) });
  return ledger?.decision === 'accepted' && ledger.versionHash === digest(POLICIES[policyKey])
    ? { allowed: true } : { allowed: false, code: 'CONSENT_REQUIRED', policyKey, policy: POLICIES[policyKey], versionHash: digest(POLICIES[policyKey]) };
}
export async function consentHistory({ db, user, policyKey }) {
  if (!Object.hasOwn(POLICIES, policyKey)) throw new TrustError('UNKNOWN_POLICY', 400);
  const actor = actorId(user);
  const ledger = await db.collection('consent_ledgers').findOne({ _id: digest({ actor, policyKey }) });
  return ledger?.events || [];
}

import crypto from 'node:crypto';

/**
 * Idempotent, spoof-resistant email subscription workflow — Issue #680.
 *
 * Subscription endpoints/jobs today can create duplicate opt-in records or
 * trust inbound provider events blindly. This module hardens that workflow:
 *
 *   - Idempotent subscribe/unsubscribe: a single canonical "email + preference
 *     key" record is upserted, so duplicate opt-ins never create duplicate
 *     documents (and the operation is safe to retry).
 *   - Consent + source audit: every transition records `consentAt` (or
 *     `unsubscribedAt`), a `source`, and an `origin` (e.g. which provider the
 *     event came from), so compliance can show *who* opted in/out and *why*.
 *   - Spoof-resistant webhook handling: inbound provider events are verified
 *     against a per-provider signing secret (`verifyWebhookSignature`) before
 *     any state change is applied. Unverified events are rejected and reported.
 *
 * All DB access is injected so the logic can be unit-tested without MongoDB.
 */

/** Canonical key for an email subscription record. */
export function subscriptionKey(email, preferenceKey) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) throw new Error('subscriptionGuard: email is required');
  if (!preferenceKey) throw new Error('subscriptionGuard: preferenceKey is required');
  return `${normalizedEmail}::${preferenceKey}`;
}

/**
 * Apply an idempotent subscribe (or unsubscribe) transition to a subscription.
 *
 * Because the update is a Mongo upsert keyed on the canonical `key`, submitting
 * the same opt-in twice collapses into a single document and single consent
 * record. No new rows are created on retries.
 *
 * @param {object} params
 * @param {object} params.db - MongoDB database instance.
 * @param {string} params.email
 * @param {string} params.preferenceKey - e.g. 'weeklyEarnings' | 'productUpdates'
 * @param {'subscribe'|'unsubscribe'} params.action
 * @param {string} [params.source] - where the request came from (e.g. 'link', 'api', 'webhook')
 * @param {string} [params.origin] - provider/system that emitted the event (e.g. 'resend', 'mailchimp')
 * @param {boolean} [params.verified] - true when the event passed signature verification
 * @returns {Promise<{created: boolean, updated: boolean, record: object}>}
 */
export async function applySubscriptionTransition({
  db,
  email,
  preferenceKey,
  action,
  source = 'api',
  origin = null,
  verified = true,
}) {
  if (!db) throw new Error('subscriptionGuard: db is required');
  const key = subscriptionKey(email, preferenceKey);
  const now = new Date();

  if (action === 'subscribe') {
    const update = {
      $set: {
        key,
        email: String(email).trim().toLowerCase(),
        preferenceKey,
        subscribed: true,
        // Consent is only stamped on an actual opt-in transition. On a retry it
        // is preserved (not re-minted), and never downgraded on unsubscribe.
        ...(verified ? { consentAt: now } : {}),
        source: verified ? source : 'unverified-input',
        origin: verified ? origin : null,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
        unsubscribedAt: null,
      },
      $unset: unsetUnsubscribe(),
    };
    const result = await db.collection('email_subscriptions').updateOne({ key }, update, { upsert: true });
    const record = await db.collection('email_subscriptions').findOne({ key });
    const created = Boolean(result.upsertedCount);
    return { created, updated: result.modifiedCount > 0, record };
  }

  if (action === 'unsubscribe') {
    const update = {
      $set: {
        key,
        email: String(email).trim().toLowerCase(),
        preferenceKey,
        subscribed: false,
        ...(verified ? { unsubscribedAt: now, unsubscribedSource: source } : {}),
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
        consentAt: null,
      },
      $unset: unsetConsent(),
    };
    const result = await db.collection('email_subscriptions').updateOne({ key }, update, { upsert: true });
    const record = await db.collection('email_subscriptions').findOne({ key });
    const created = Boolean(result.upsertedCount);
    return { created, updated: result.modifiedCount > 0, record };
  }

  throw new Error(`subscriptionGuard: unknown action "${action}"`);
}

function unsetUnsubscribe() {
  return { unsubscribedAt: '', unsubscribedSource: '' };
}
function unsetConsent() {
  return { consentAt: '', consentSource: '' };
}

/**
 * Verify an inbound provider webhook event before applying it.
 *
 * Mirrors the webhook wire format used by `src/lib/webhooks/sender.js`
 * (`X-EduVault-Signature` header shaped `t=<ts>,v1=<hmac>`), implemented
 * locally with node:crypto so this module can run under plain `node --test`
 * without pulling in the sender's MongoDB/logger top-level imports.
 *
 * @param {object} params
 * @param {string} params.body - raw request body (use the *exact* bytes the
 *   provider signed; do not JSON.stringify a re-parsed object).
 * @param {string} params.signatureHeader - provider signature header value.
 * @param {string} params.secret - provider signing secret for this channel.
 * @param {number} [params.toleranceSeconds]
 * @param {number} [params.now] - epoch seconds (tests override this).
 * @returns {boolean}
 */
export function verifyProviderWebhook({ body, signatureHeader, secret, toleranceSeconds = 300, now = Math.floor(Date.now() / 1000) }) {
  if (!body || !signatureHeader || !secret) return false;
  const header = String(signatureHeader);
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=')));
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isFinite(timestamp) || !signature) return false;
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;
  const signedPayload = `${timestamp}.${body}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Build a raw-body HMAC signature (used chiefly by tests/simulators). Mirrors
 * `createWebhookSignatureHeader` for parity with `verifyProviderWebhook`.
 */
export function signProviderWebhook(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signedPayload = `${timestamp}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  subscriptionKey,
  applySubscriptionTransition,
  verifyProviderWebhook,
  signProviderWebhook,
} from '../../src/lib/email/subscriptionGuard.js';

/** Minimal in-memory fake for the `email_subscriptions` collection. */
function makeFakeDb() {
  const store = new Map();
  const collection = {
    async updateOne(query, update, { upsert = false } = {}) {
      const key = query.key;
      let existing = store.get(key);
      if (existing) {
        // merge $set / apply $unset
        if (update.$set) existing = { ...existing, ...update.$set };
        if (update.$unset) {
          for (const k of Object.keys(update.$unset)) delete existing[k];
        }
        store.set(key, existing);
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (upsert) {
        existing = { key, _id: `doc_${key}`, ...(update.$set || {}), ...(update.$setOnInsert || {}) };
        store.set(key, existing);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },
    async findOne(query) {
      return store.get(query.key) ?? null;
    },
    _store: store,
  };
  return {
    collection: () => collection,
  };
}

const EMAIL = 'learner@example.com';
const KEY = 'weeklyEarnings';

describe('Email subscription guard (#680)', () => {
  it('canonical key is lower-cased and unique per email+preference', () => {
    assert.equal(subscriptionKey('Learner@Example.com', KEY), 'learner@example.com::weeklyEarnings');
    assert.equal(subscriptionKey(EMAIL, KEY), subscriptionKey('LEARNER@example.com', KEY));
    assert.throws(() => subscriptionKey('', KEY), /email/);
    assert.throws(() => subscriptionKey(EMAIL, ''), /preferenceKey/);
  });

  it('duplicate opt-ins do not create duplicate records', async () => {
    const db = makeFakeDb();
    const a = await applySubscriptionTransition({ db, email: EMAIL, preferenceKey: KEY, action: 'subscribe' });
    const b = await applySubscriptionTransition({ db, email: EMAIL, preferenceKey: KEY, action: 'subscribe' });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(db.collection()._store.size, 1);
    const record = await db.collection().findOne({ key: subscriptionKey(EMAIL, KEY) });
    assert.equal(record.subscribed, true);
    assert.ok(record.consentAt);
  });

  it('subscribe then unsubscribe collapses to a single doc with unsubscribedAt', async () => {
    const db = makeFakeDb();
    await applySubscriptionTransition({ db, email: EMAIL, preferenceKey: KEY, action: 'subscribe' });
    const un = await applySubscriptionTransition({ db, email: EMAIL, preferenceKey: KEY, action: 'unsubscribe' });
    assert.equal(un.created, false);
    assert.equal(db.collection()._store.size, 1);
    const record = await db.collection().findOne({ key: subscriptionKey(EMAIL, KEY) });
    assert.equal(record.subscribed, false);
    assert.ok(record.unsubscribedAt);
    assert.equal(record.consentAt, undefined);
  });

  it('unknown action throws', async () => {
    const db = makeFakeDb();
    await assert.rejects(
      () => applySubscriptionTransition({ db, email: EMAIL, preferenceKey: KEY, action: 'bogus' }),
      /unknown action/
    );
  });

  it('rejects spoofed webhook events (invalid signature)', async () => {
    const body = JSON.stringify({ type: 'unsubscribe', email: EMAIL, preferenceKey: KEY });
    const ok = verifyProviderWebhook({
      body,
      signatureHeader: 't=1,v1=deadbeef',
      secret: 'provider-secret',
      now: 1,
    });
    assert.equal(ok, false);
  });

  it('accepts a validly signed webhook event within tolerance', async () => {
    const body = JSON.stringify({ type: 'subscribe', email: EMAIL, preferenceKey: KEY });
    const now = Math.floor(Date.now() / 1000);
    const header = signProviderWebhook(body, 'provider-secret', now);
    const ok = verifyProviderWebhook({ body, signatureHeader: header, secret: 'provider-secret', now });
    assert.equal(ok, true);
  });

  it('rejects a valid signature that is replayed outside tolerance', async () => {
    const body = 'raw-payload';
    const old = Math.floor(Date.now() / 1000) - 99999;
    const header = signProviderWebhook(body, 'provider-secret', old);
    const ok = verifyProviderWebhook({
      body,
      signatureHeader: header,
      secret: 'provider-secret',
      now: Math.floor(Date.now() / 1000),
      toleranceSeconds: 300,
    });
    assert.equal(ok, false);
  });
});
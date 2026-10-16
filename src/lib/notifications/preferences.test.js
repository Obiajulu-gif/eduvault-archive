import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '@/lib/mongodb';
import { REQUIRED_INDEXES } from '@/lib/backend/schemaContracts';
import { notify, listNotifications, DELIVERY_STATUSES, retryFailedDelivery } from './notifications';
import {
  NotificationPreferenceError,
  listNotificationPreferences,
  resolveNotificationDelivery,
  setNotificationPreference,
} from './preferences';

// Real Mongo, like notifications.test.js: the unique index and upsert behaviour
// are what keep preferences and suppressed records correct.
let db;

beforeAll(async () => {
  db = await getDb();
  for (const { keys, options } of REQUIRED_INDEXES.notifications) {
    await db.collection('notifications').createIndex(keys, options);
  }
  for (const { keys, options } of REQUIRED_INDEXES.notification_preferences) {
    await db.collection('notification_preferences').createIndex(keys, options);
  }
});

beforeEach(async () => {
  await db.collection('notifications').deleteMany({});
  await db.collection('notification_preferences').deleteMany({});
});

const event = (overrides = {}) => ({
  recipient: 'user-a',
  type: 'import_completed',
  dedupeKey: 'import:batch-1',
  title: 'Import completed',
  message: '2 created',
  link: '/dashboard/my-materials',
  ...overrides,
});

describe('resolveNotificationDelivery', () => {
  it('always delivers mandatory types, even with an opt-out on record', () => {
    expect(resolveNotificationDelivery({ type: 'payment_failed', enabled: false })).toEqual({ deliver: true, reason: 'mandatory' });
    expect(resolveNotificationDelivery({ type: 'some_future_type', enabled: false })).toEqual({ deliver: true, reason: 'mandatory' });
  });

  it('honours optional opt-outs and defaults to delivering', () => {
    expect(resolveNotificationDelivery({ type: 'import_completed', enabled: false })).toEqual({ deliver: false, reason: 'opted_out' });
    expect(resolveNotificationDelivery({ type: 'import_completed' })).toEqual({ deliver: true, reason: 'default' });
    expect(resolveNotificationDelivery({ type: 'import_completed', enabled: true })).toEqual({ deliver: true, reason: 'opted_in' });
  });
});

describe('setNotificationPreference', () => {
  it('refuses to silence a mandatory alert', async () => {
    await expect(setNotificationPreference(db, 'user-a', 'account_suspended', false))
      .rejects.toBeInstanceOf(NotificationPreferenceError);
    expect(await db.collection('notification_preferences').countDocuments({})).toBe(0);
  });

  it('upserts one durable preference per recipient and type', async () => {
    await setNotificationPreference(db, 'user-a', 'import_completed', false);
    await setNotificationPreference(db, 'user-a', 'import_completed', true);
    const prefs = await listNotificationPreferences(db, 'user-a');
    expect(prefs.find((p) => p.type === 'import_completed').enabled).toBe(true);
    expect(await db.collection('notification_preferences').countDocuments({ recipient: 'user-a' })).toBe(1);
  });

  it('rejects a non-boolean enabled value', async () => {
    await expect(setNotificationPreference(db, 'user-a', 'import_completed', 'no'))
      .rejects.toBeInstanceOf(NotificationPreferenceError);
  });
});

describe('notify with preferences', () => {
  it('suppresses an opted-out optional notification but keeps an audit record', async () => {
    await setNotificationPreference(db, 'user-a', 'import_completed', false);
    expect(await notify(db, event())).toEqual({ created: true });

    const stored = await db.collection('notifications').findOne({ recipient: 'user-a' });
    expect(stored.suppressed).toBe(true);
    expect(stored.suppressedReason).toBe('opted_out');
    expect(stored.deliveryStatus).toBe(DELIVERY_STATUSES.suppressed);

    expect(await listNotifications(db, 'user-a')).toEqual({ notifications: [], unreadCount: 0 });
  });

  it('never suppresses mandatory alerts, even for a user who was never asked', async () => {
    await notify(db, event({ type: 'payment_failed', dedupeKey: 'pay-1', link: '/dashboard/purchases' }));
    const { notifications, unreadCount } = await listNotifications(db, 'user-a');
    expect(notifications).toHaveLength(1);
    expect(unreadCount).toBe(1);
  });

  it('a suppressed notification is never delivered by a retry', async () => {
    await setNotificationPreference(db, 'user-a', 'import_partial_failure', false);
    await notify(db, event({ type: 'import_partial_failure', dedupeKey: 'p-1' }));
    const stored = await db.collection('notifications').findOne({ dedupeKey: 'p-1' });

    const deliver = async () => { throw new Error('should not deliver'); };
    const result = await retryFailedDelivery(db, String(stored._id), deliver, { recipient: 'user-a' });
    expect(result.outcome).toBe('suppressed');
  });
});

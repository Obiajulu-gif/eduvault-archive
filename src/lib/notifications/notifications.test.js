import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { getDb } from '@/lib/mongodb';
import { REQUIRED_INDEXES } from '@/lib/backend/schemaContracts';
import {
  notify,
  listNotifications,
  markNotificationsRead,
  notifyWalletRecipient,
  resolveRecipientByWallet,
  NOTIFICATION_TYPES,
  FEATURE_FLAG_GATED_TYPES,
} from './notifications';

// Real Mongo (vitest globalSetup starts mongodb-memory-server): dedupe relies
// on upsert + unique-index semantics a mock wouldn't reproduce.
let db;

beforeAll(async () => {
  db = await getDb();
  for (const { keys, options } of REQUIRED_INDEXES.notifications) {
    await db.collection('notifications').createIndex(keys, options);
  }
});

beforeEach(async () => {
  await db.collection('notifications').deleteMany({});
  await db.collection('users').deleteMany({});
});

afterEach(() => {
  delete process.env.FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS;
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

describe('notify', () => {
  it('creates a notification once even when the event is retried', async () => {
    expect(await notify(db, event())).toEqual({ created: true });
    expect(await notify(db, event())).toEqual({ created: false });

    const results = await Promise.all([notify(db, event({ dedupeKey: 'k2' })), notify(db, event({ dedupeKey: 'k2' }))]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await db.collection('notifications').countDocuments({})).toBe(2);
  });

  it('dedupes per recipient, not globally', async () => {
    await notify(db, event());
    expect(await notify(db, event({ recipient: 'user-b' }))).toEqual({ created: true });
  });

  it('rejects unknown types and non-internal deep links', async () => {
    await expect(notify(db, event({ type: 'nope' }))).rejects.toThrow(/Unknown notification type/);
    for (const link of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      await expect(notify(db, event({ link }))).rejects.toThrow(/internal path/);
    }
  });
});

describe('listNotifications / markNotificationsRead', () => {
  it('only returns and updates the recipient\'s own notifications', async () => {
    await notify(db, event());
    await notify(db, event({ recipient: 'user-b', dedupeKey: 'b-1', message: 'private to b' }));

    const a = await listNotifications(db, 'user-a');
    expect(a.notifications).toHaveLength(1);
    expect(a.notifications[0].message).toBe('2 created');
    expect(a.notifications[0]).not.toHaveProperty('recipient');

    const bId = (await listNotifications(db, 'user-b')).notifications[0].id;
    expect(await markNotificationsRead(db, 'user-a', { ids: [bId] })).toEqual({ updated: 0 });
    expect((await listNotifications(db, 'user-b')).unreadCount).toBe(1);
  });

  it('tracks read state per id and for all', async () => {
    await notify(db, event());
    await notify(db, event({ dedupeKey: 'k2', type: 'import_partial_failure' }));

    const { notifications, unreadCount } = await listNotifications(db, 'user-a');
    expect(unreadCount).toBe(2);

    await markNotificationsRead(db, 'user-a', { ids: [notifications[0].id, 'not-an-object-id'] });
    const afterOne = await listNotifications(db, 'user-a', { unreadOnly: true });
    expect(afterOne.unreadCount).toBe(1);
    expect(afterOne.notifications).toHaveLength(1);

    expect(await markNotificationsRead(db, 'user-a', { all: true })).toEqual({ updated: 1 });
    expect((await listNotifications(db, 'user-a')).unreadCount).toBe(0);
  });
});

// ── #776: critical lifecycle / recovery events ───────────────────────────────

describe('critical lifecycle notifications', () => {
  const WALLET = 'GNOTIFY_WALLET_00000000000000000000000000000000000000000';

  async function seedUser(overrides = {}) {
    const doc = {
      walletAddress: WALLET,
      walletAddressLower: WALLET.toLowerCase(),
      email: 'notify@example.com',
      fullName: 'Notify User',
      ...overrides,
    };
    const result = await db.collection('users').insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  it('registers every critical lifecycle type with a severity and default link', () => {
    for (const type of [
      'purchase_completed', 'payment_failed', 'refund_requested', 'refund_settled',
      'refund_failed', 'entitlement_revoked', 'payout_processed', 'account_suspended',
      'account_reactivated', 'wallet_recovery_completed',
    ]) {
      expect(NOTIFICATION_TYPES[type]).toBeDefined();
      expect(NOTIFICATION_TYPES[type].severity).toBeTruthy();
      expect(NOTIFICATION_TYPES[type].defaultLink).toMatch(/^\//);
      expect(FEATURE_FLAG_GATED_TYPES.has(type)).toBe(true);
    }
  });

  it('resolveRecipientByWallet maps a wallet address to the user id', async () => {
    const user = await seedUser();
    expect(await resolveRecipientByWallet(db, WALLET)).toBe(String(user._id));
    expect(await resolveRecipientByWallet(db, WALLET.toLowerCase())).toBe(String(user._id));
  });

  it('resolveRecipientByWallet returns null for an unknown address', async () => {
    expect(await resolveRecipientByWallet(db, 'GUNKNOWN_00000000000000000000000000000000000000000')).toBeNull();
  });

  it('notifyWalletRecipient delivers to the wallet owner when the flag is on', async () => {
    process.env.FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS = 'true';
    const user = await seedUser();

    const result = await notifyWalletRecipient(db, {
      walletAddress: WALLET,
      type: 'refund_settled',
      dedupeKey: 'refund:settled:test-1',
      title: 'Refund completed',
      message: 'Your refund was completed.',
      link: '/dashboard/purchases',
    });

    expect(result.created).toBe(true);
    const inbox = await listNotifications(db, String(user._id));
    expect(inbox.notifications).toHaveLength(1);
    expect(inbox.notifications[0].type).toBe('refund_settled');
    expect(inbox.notifications[0].severity).toBe('success');
    expect(inbox.notifications[0].link).toBe('/dashboard/purchases');
  });

  it('notifyWalletRecipient skips delivery when the flag is off (safe default)', async () => {
    delete process.env.FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS;
    const user = await seedUser();

    const result = await notifyWalletRecipient(db, {
      walletAddress: WALLET,
      type: 'refund_settled',
      dedupeKey: 'refund:settled:test-2',
      title: 'Refund completed',
      message: 'Your refund was completed.',
    });

    expect(result.created).toBe(false);
    expect(result.skipped).toBe('feature_flag_disabled');
    expect((await listNotifications(db, String(user._id))).notifications).toHaveLength(0);
  });

  it('notifyWalletRecipient skips when no user record exists for the wallet', async () => {
    process.env.FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS = 'true';
    const result = await notifyWalletRecipient(db, {
      walletAddress: 'GUNKNOWN_000000000000000000000000000000000000000000',
      type: 'refund_settled',
      dedupeKey: 'refund:settled:test-3',
      title: 'Refund completed',
      message: 'Your refund was completed.',
    });

    expect(result.created).toBe(false);
    expect(result.skipped).toBe('recipient_not_found');
  });

  it('retried critical events do not create duplicate notifications', async () => {
    process.env.FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS = 'true';
    const user = await seedUser();
    const payload = {
      walletAddress: WALLET,
      type: 'refund_failed',
      dedupeKey: 'refund:failed:test-4',
      title: 'Refund needs attention',
      message: 'We could not complete your refund.',
    };

    expect((await notifyWalletRecipient(db, payload)).created).toBe(true);
    expect((await notifyWalletRecipient(db, payload)).created).toBe(false);
    expect((await notifyWalletRecipient(db, payload)).created).toBe(false);

    const inbox = await listNotifications(db, String(user._id));
    expect(inbox.notifications).toHaveLength(1);
    expect(inbox.unreadCount).toBe(1);
  });

  it('critical notifications are scoped to the recipient and expose no private data', async () => {
    process.env.FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS = 'true';
    const user = await seedUser();
    await notifyWalletRecipient(db, {
      walletAddress: WALLET,
      type: 'account_suspended',
      dedupeKey: 'account:suspend:test-5',
      title: 'Account suspended',
      message: 'Your account was suspended.',
    });

    const pub = (await listNotifications(db, String(user._id))).notifications[0];
    expect(pub).not.toHaveProperty('recipient');
    expect(pub).not.toHaveProperty('dedupeKey');
    expect(pub).not.toHaveProperty('walletAddress');
  });
});

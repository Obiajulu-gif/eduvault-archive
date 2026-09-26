import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '@/lib/mongodb';
import { REQUIRED_INDEXES } from '@/lib/backend/schemaContracts';
import { notify, listNotifications, markNotificationsRead } from './notifications';

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

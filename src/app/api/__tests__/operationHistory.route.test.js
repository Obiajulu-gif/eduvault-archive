// @vitest-environment node
//
// #882: HTTP wiring for GET /api/operations/history. Visibility, redaction,
// pagination and filtering are covered in tests/backend/operation-history.test.mjs.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoClient, ObjectId } from 'mongodb';

const { currentAuth, database } = vi.hoisted(() => ({ currentAuth: { value: null }, database: { db: null } }));

vi.mock('@/lib/api/auth', () => ({ requireActiveUser: vi.fn(async () => currentAuth.value) }));
vi.mock('@/lib/api/hardening', () => ({ withApiHardening: vi.fn((req, options, handler) => handler()) }));
// The global setup mocks @/lib/mongodb and the audit ledger with fixed fakes.
vi.mock('@/lib/mongodb', () => ({ getDb: vi.fn(async () => database.db) }));
vi.mock('@/lib/backend/auditLedger', async (importOriginal) => importOriginal());

import { appendAuditRecord } from '@/lib/backend/auditLedger';
import { GET } from '../operations/history/route';

const WALLET = 'GROUTE2QXDWUC7Z2V6XPW2MQXQ7CQ4M5U7EJZ2W3V5Y6Z7A2B3C4D5E6';
const user = { _id: new ObjectId(), walletAddress: WALLET };
const get = (query = '') => new Request(`http://localhost/api/operations/history${query}`);

let client;

beforeAll(async () => {
  client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  database.db = client.db('operation_history_route_test');
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await database.db.collection('audit_ledger').deleteMany({});
  await appendAuditRecord({
    db: database.db,
    operationId: 'route:1',
    actor: WALLET,
    action: 'purchase.reserved',
    target: { type: 'material', id: 'm-1' },
    result: { status: 'reserved' },
  });
});

describe('GET /api/operations/history', () => {
  it('requires an active session', async () => {
    currentAuth.value = { ok: false, status: 401 };
    expect((await GET(get())).status).toBe(401);
  });

  it("returns the caller's history without caching", async () => {
    currentAuth.value = { ok: true, user };
    const response = await GET(get('?limit=10'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body.events.map((e) => e.type)).toEqual(['purchase.started']);
    expect(body).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('returns problem details for invalid queries', async () => {
    currentAuth.value = { ok: true, user };
    const response = await GET(get('?category=secrets'));
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });
});

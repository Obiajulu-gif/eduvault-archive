// @vitest-environment node
//
// #793: contract drift tests. Real route handlers run against Mongo
// (mongodb-memory-server via vitest globalSetup) and every response body is
// checked against the schema documented for that status in docs/openapi.yaml.
// Removing or retyping a documented field, or changing a status code without
// updating the spec, fails here.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { Collection } from 'mongodb';

const { currentUser } = vi.hoisted(() => ({ currentUser: { value: null } }));

vi.mock('@/lib/api/auth', () => ({ getUserFromCookie: vi.fn(async () => currentUser.value) }));
vi.mock('@/lib/api/hardening', () => ({ withApiHardening: vi.fn((req, options, handler) => handler()) }));
vi.mock('@/lib/api/audit', () => ({ auditLog: vi.fn() }));
vi.mock('@/lib/cache/redis', () => ({ invalidateCatalogCache: vi.fn() }));

import { getDb } from '@/lib/mongodb';
import { REQUIRED_INDEXES } from '@/lib/backend/schemaContracts';
import { POST as importMaterials } from '../materials/import/route';
import { GET as listNotifications, PATCH as markRead } from '../notifications/route';

const spec = parse(readFileSync(new URL('../../../../docs/openapi.yaml', import.meta.url), 'utf8'));

function resolve(schema) {
  let s = schema;
  while (s?.$ref) s = s.$ref.replace('#/', '').split('/').reduce((node, key) => node[key], spec);
  return s;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

// Minimal JSON Schema subset used by the spec: $ref, allOf, oneOf, type
// (incl. arrays), required, properties, items, enum.
function validate(value, rawSchema, path = '$') {
  const schema = resolve(rawSchema);
  if (!schema) return [];
  if (schema.allOf) return schema.allOf.flatMap((s) => validate(value, s, path));
  if (schema.oneOf) {
    const results = schema.oneOf.map((s) => validate(value, s, path));
    return results.some((r) => r.length === 0) ? [] : [`${path}: matches no oneOf branch (${results.flat().join('; ')})`];
  }
  const errors = [];
  if (schema.type) {
    const allowed = [].concat(schema.type);
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      return [`${path}: expected ${allowed.join('|')}, got ${actual}`];
    }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key}: required but missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) errors.push(...validate(value[key], sub, `${path}.${key}`));
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
  }
  return errors;
}

async function expectContract(res, route, method) {
  const operation = spec.paths[route][method];
  const documented = operation.responses[String(res.status)];
  expect(documented, `${method.toUpperCase()} ${route} returned undocumented status ${res.status}`).toBeDefined();
  const body = await res.json();
  const schema = resolve(documented).content['application/json'].schema;
  expect(validate(body, schema)).toEqual([]);
  return body;
}

const jsonRequest = (url, method, body) => new Request(`http://localhost${url}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const runImport = (body) => importMaterials(jsonRequest('/api/materials/import', 'POST', body));

let db;
let userAddress;

beforeAll(async () => {
  db = await getDb();
  for (const collection of ['materials', 'notifications']) {
    for (const { keys, options } of REQUIRED_INDEXES[collection]) {
      await db.collection(collection).createIndex(keys, options);
    }
  }
});

beforeEach(() => {
  userAddress = `GTEST${Math.random().toString(36).slice(2).toUpperCase()}`;
  currentUser.value = { sub: `user-${userAddress}`, walletAddress: userAddress };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const records = [
  { externalId: 'ext-1', title: 'Algebra notes', storageKey: 'ipfs://algebra', price: 2 },
  { externalId: 'ext-2', title: 'Physics notes', storageKey: 'ipfs://physics' },
];

describe('POST /api/materials/import contract', () => {
  it('dry run returns the plan and performs no persistent writes', async () => {
    const writeMethods = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'bulkWrite', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate'];
    const spies = writeMethods.map((m) => vi.spyOn(Collection.prototype, m));

    const res = await runImport({ dryRun: true, records });
    const body = await expectContract(res, '/api/materials/import', 'post');

    expect(res.status).toBe(200);
    expect(body.summary).toEqual({ create: 2, update: 0, skip: 0, error: 0 });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('dry run reports invalid and duplicate rows with 400 and no writes', async () => {
    const res = await runImport({
      dryRun: true,
      records: [...records, { externalId: 'ext-1', title: 'Dup', storageKey: 'ipfs://dup' }, { title: '', storageKey: 'ipfs://x' }],
    });
    const body = await expectContract(res, '/api/materials/import', 'post');

    expect(res.status).toBe(400);
    expect(body.invalidRows.map((r) => r.row)).toEqual([3, 4]);
    expect(await db.collection('materials').countDocuments({ userAddress })).toBe(0);
  });

  it('commit with invalid rows writes nothing', async () => {
    const res = await runImport({ dryRun: false, records: [...records, { title: 'No key' }] });
    await expectContract(res, '/api/materials/import', 'post');

    expect(res.status).toBe(400);
    expect(await db.collection('materials').countDocuments({ userAddress })).toBe(0);
  });

  it('commit creates, then a repeated import is idempotent, then changes become updates', async () => {
    const first = await runImport({ dryRun: false, records });
    const firstBody = await expectContract(first, '/api/materials/import', 'post');
    expect(first.status).toBe(201);
    expect(firstBody).toMatchObject({ created: 2, updated: 0, imported: 2, failedRows: [] });
    expect(await db.collection('materials').countDocuments({ userAddress, importBatchId: firstBody.importBatchId })).toBe(2);

    const again = await runImport({ dryRun: false, records });
    const againBody = await expectContract(again, '/api/materials/import', 'post');
    expect(again.status).toBe(200);
    expect(againBody.summary).toEqual({ create: 0, update: 0, skip: 2, error: 0 });
    expect(await db.collection('materials').countDocuments({ userAddress })).toBe(2);

    const changed = await runImport({ dryRun: false, records: [{ ...records[0], title: 'Algebra notes v2' }, records[1]] });
    const changedBody = await expectContract(changed, '/api/materials/import', 'post');
    expect(changedBody).toMatchObject({ created: 0, updated: 1, summary: { update: 1, skip: 1 } });
    const history = await db.collection('material_history').findOne({ changeReason: `import ${changedBody.importBatchId}` });
    expect(history.changes.title).toEqual({ from: 'Algebra notes', to: 'Algebra notes v2' });

    const inbox = await db.collection('notifications').find({ recipient: currentUser.value.sub }).toArray();
    expect(inbox.map((n) => n.type)).toEqual(['import_completed', 'import_completed']);
  });

  it('partial failure returns 207 with failedRows and rollback guidance', async () => {
    await runImport({ dryRun: false, records: [records[0]] });

    // Simulate a concurrent import landing between planning and writing: the
    // plan misses ext-1, so its insert hits the unique index while ext-2 lands.
    vi.spyOn(Collection.prototype, 'find').mockReturnValueOnce({ toArray: async () => [] });
    const res = await runImport({ dryRun: false, records });
    const body = await expectContract(res, '/api/materials/import', 'post');

    expect(res.status).toBe(207);
    expect(body.created).toBe(1);
    expect(body.failedRows).toEqual([expect.objectContaining({ row: 1, action: 'create', code: 11000 })]);
    expect(body.rollback.importBatchId).toBe(body.importBatchId);
    expect(await db.collection('materials').countDocuments({ userAddress, externalId: 'ext-1' })).toBe(1);

    const failure = await db.collection('notifications').findOne({ recipient: currentUser.value.sub, dedupeKey: `import:${body.importBatchId}` });
    expect(failure.type).toBe('import_partial_failure');
  });

  it('malformed payload returns the documented error shape', async () => {
    const res = await runImport({ records: [] });
    const body = await expectContract(res, '/api/materials/import', 'post');
    expect(body.error).toMatch(/no records/);
  });
});

describe('/api/notifications contract', () => {
  it('rejects unauthenticated callers with the Error shape', async () => {
    currentUser.value = null;
    const res = await listNotifications(jsonRequest('/api/notifications', 'GET'));
    expect(res.status).toBe(401);
    await expectContract(res, '/api/notifications', 'get');
  });

  it('lists and marks only the caller\'s notifications', async () => {
    await runImport({ dryRun: false, records: [records[0]] });

    const res = await listNotifications(jsonRequest('/api/notifications?limit=5', 'GET'));
    const body = await expectContract(res, '/api/notifications', 'get');
    expect(body.unreadCount).toBe(1);
    expect(body.notifications[0].link).toBe('/dashboard/my-materials');
    const id = body.notifications[0].id;

    const owner = currentUser.value;
    currentUser.value = { sub: 'someone-else' };
    const foreign = await markRead(jsonRequest('/api/notifications', 'PATCH', { ids: [id] }));
    expect((await expectContract(foreign, '/api/notifications', 'patch')).updated).toBe(0);

    currentUser.value = owner;
    const own = await markRead(jsonRequest('/api/notifications', 'PATCH', { ids: [id] }));
    expect((await expectContract(own, '/api/notifications', 'patch')).updated).toBe(1);

    const empty = await markRead(jsonRequest('/api/notifications', 'PATCH', {}));
    expect(empty.status).toBe(400);
    await expectContract(empty, '/api/notifications', 'patch');
  });
});

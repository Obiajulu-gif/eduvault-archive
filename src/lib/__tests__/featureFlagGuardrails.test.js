// @vitest-environment node
/**
 * src/lib/__tests__/featureFlagGuardrails.test.js
 *
 * Tests for the feature rollout guardrails and emergency disablement layer
 * added in #1018.
 *
 * Coverage:
 *   resolveFeatureFlag
 *     ✓ DB override (enabled:true) wins over a disabled env var
 *     ✓ DB override (enabled:false) wins over an enabled env var — emergency disable
 *     ✓ falls back to env var when no override exists
 *     ✓ DB failure falls back to safe default — never accidentally enables
 *     ✓ DB failure falls back to env value when env is explicitly true
 *     ✓ throws for unknown key
 *
 *   setFeatureFlagOverride
 *     ✓ writes an enabled override
 *     ✓ writes a disabled (emergency) override
 *     ✓ upserts — repeated writes are idempotent
 *     ✓ throws for unknown key
 *     ✓ throws when enabled is not a boolean
 *
 *   clearFeatureFlagOverride
 *     ✓ removes an existing override and returns true
 *     ✓ returns false when no override existed
 *     ✓ throws for unknown key
 *
 *   listFeatureFlagsResolved
 *     ✓ returns one entry per registered flag
 *     ✓ entries with overrides report source:'override'
 *     ✓ entries without overrides report env or default source
 *
 *   withFeatureGuard
 *     ✓ throws at wrap time for unknown flag key
 *     ✓ passes through to handler when flag enabled via env
 *     ✓ returns 503 when flag disabled via env (no override)
 *     ✓ returns 503 when DB override disables flag (env says enabled)
 *     ✓ DB failure + env enabled — handler still called
 *     ✓ DB failure + no env var — returns 503 (safe default)
 *
 *   Admin API GET /api/admin/feature-flags
 *     ✓ normal path — returns all flags to admin
 *     ✓ 401 for unauthenticated callers
 *     ✓ 403 for non-admin callers
 *     ✓ DB unavailable — returns env/default with warning
 *
 *   Admin API POST /api/admin/feature-flags
 *     ✓ normal path — enables a flag
 *     ✓ emergency disable — disables a flag
 *     ✓ clear override — reverts to env/default
 *     ✓ idempotent — repeated disable is safe
 *     ✓ 400 for unknown flag key
 *     ✓ 400 for missing key field
 *     ✓ 400 for non-boolean enabled without clear:true
 *     ✓ 401/403 for unauthorized callers
 *     ✓ 503 retryable when DB unavailable on write
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FEATURE_FLAG_REGISTRY,
  resolveFeatureFlag,
  setFeatureFlagOverride,
  clearFeatureFlagOverride,
  listFeatureFlagsResolved,
  withFeatureGuard,
  OVERRIDE_COLLECTION,
} from '../featureFlags.js';

// ─── Fake MongoDB helpers ─────────────────────────────────────────────────────

function makeFakeOverridesCollection(initial = []) {
  const docs = initial.map((d) => ({ ...d }));
  return {
    docs,
    async findOne(query) {
      return docs.find((d) => d.key === query.key) ?? null;
    },
    async updateOne(filter, update, opts = {}) {
      const idx = docs.findIndex((d) => d.key === filter.key);
      if (idx === -1 && opts.upsert) {
        docs.push({ ...update.$set });
        return { matchedCount: 0, upsertedCount: 1 };
      }
      if (idx !== -1) {
        Object.assign(docs[idx], update.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      }
      return { matchedCount: 0 };
    },
    async deleteOne(filter) {
      const idx = docs.findIndex((d) => d.key === filter.key);
      if (idx === -1) return { deletedCount: 0 };
      docs.splice(idx, 1);
      return { deletedCount: 1 };
    },
  };
}

function makeFakeDb(overridesCol) {
  return { collection: (name) => (name === OVERRIDE_COLLECTION ? overridesCol : null) };
}

// ─── Env var cleanup ──────────────────────────────────────────────────────────

const FLAG_ENV_VARS = Object.keys(FEATURE_FLAG_REGISTRY).map((k) => `FEATURE_FLAG_${k}`);
const ORIGINAL_ENV = Object.fromEntries(FLAG_ENV_VARS.map((n) => [n, process.env[n]]));

afterEach(() => {
  for (const name of FLAG_ENV_VARS) {
    if (ORIGINAL_ENV[name] === undefined) delete process.env[name];
    else process.env[name] = ORIGINAL_ENV[name];
  }
  vi.clearAllMocks();
});

// ─── resolveFeatureFlag ───────────────────────────────────────────────────────

describe('resolveFeatureFlag', () => {
  it('DB override enabled:true wins over a disabled env var', async () => {
    process.env.FEATURE_FLAG_ARCHIVE_MATERIAL = 'false';
    const db = makeFakeDb(makeFakeOverridesCollection([
      { key: 'ARCHIVE_MATERIAL', enabled: true, updatedBy: 'admin', reason: 'staged rollout' },
    ]));

    const result = await resolveFeatureFlag('ARCHIVE_MATERIAL', db);
    expect(result.enabled).toBe(true);
    expect(result.source).toBe('override');
    expect(result.overriddenBy).toBe('admin');
    expect(result.reason).toBe('staged rollout');
  });

  it('DB override enabled:false wins over an enabled env var (emergency disable)', async () => {
    process.env.FEATURE_FLAG_ARCHIVE_MATERIAL = 'true';
    const db = makeFakeDb(makeFakeOverridesCollection([
      { key: 'ARCHIVE_MATERIAL', enabled: false, updatedBy: 'oncall', reason: 'P1 incident' },
    ]));

    const result = await resolveFeatureFlag('ARCHIVE_MATERIAL', db);
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('override');
    expect(result.reason).toBe('P1 incident');
  });

  it('falls back to env var when no DB override exists', async () => {
    process.env.FEATURE_FLAG_ARCHIVE_MATERIAL = 'true';
    const db = makeFakeDb(makeFakeOverridesCollection([]));

    const result = await resolveFeatureFlag('ARCHIVE_MATERIAL', db);
    expect(result.enabled).toBe(true);
    expect(result.source).toBe('env');
  });

  it('DB failure falls back to safe default — never accidentally enables', async () => {
    delete process.env.FEATURE_FLAG_ARCHIVE_MATERIAL; // default = false
    const brokenDb = {
      collection: () => ({ findOne: async () => { throw new Error('connection refused'); } }),
    };

    const result = await resolveFeatureFlag('ARCHIVE_MATERIAL', brokenDb);
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('default');
  });

  it('DB failure falls back to env value when env explicitly enables', async () => {
    process.env.FEATURE_FLAG_ARCHIVE_MATERIAL = 'true';
    const brokenDb = {
      collection: () => ({ findOne: async () => { throw new Error('timeout'); } }),
    };

    const result = await resolveFeatureFlag('ARCHIVE_MATERIAL', brokenDb);
    expect(result.enabled).toBe(true);
    expect(result.source).toBe('env');
  });

  it('throws for an unregistered flag key', async () => {
    const db = makeFakeDb(makeFakeOverridesCollection([]));
    await expect(resolveFeatureFlag('DOES_NOT_EXIST', db)).rejects.toThrow('Unknown feature flag');
  });
});

// ─── setFeatureFlagOverride ───────────────────────────────────────────────────

describe('setFeatureFlagOverride', () => {
  it('writes an enabled override with metadata', async () => {
    const col = makeFakeOverridesCollection([]);
    await setFeatureFlagOverride('ARCHIVE_MATERIAL', true, makeFakeDb(col), {
      updatedBy: 'alice',
      reason: 'beta rollout',
    });

    expect(col.docs).toHaveLength(1);
    expect(col.docs[0]).toMatchObject({
      key: 'ARCHIVE_MATERIAL',
      enabled: true,
      updatedBy: 'alice',
      reason: 'beta rollout',
    });
    expect(col.docs[0].updatedAt).toBeInstanceOf(Date);
  });

  it('writes an emergency disable override', async () => {
    const col = makeFakeOverridesCollection([]);
    await setFeatureFlagOverride('ARCHIVE_MATERIAL', false, makeFakeDb(col), {
      updatedBy: 'oncall',
      reason: 'cascade failure in archive indexer',
    });

    expect(col.docs[0].enabled).toBe(false);
    expect(col.docs[0].reason).toBe('cascade failure in archive indexer');
  });

  it('upserts — repeated disable writes are idempotent (safe no-op)', async () => {
    const col = makeFakeOverridesCollection([]);
    const db = makeFakeDb(col);

    await setFeatureFlagOverride('ARCHIVE_MATERIAL', false, db, { updatedBy: 'oncall', reason: 'first' });
    await setFeatureFlagOverride('ARCHIVE_MATERIAL', false, db, { updatedBy: 'oncall', reason: 'second' });

    expect(col.docs).toHaveLength(1); // not two inserts
    expect(col.docs[0].reason).toBe('second'); // last write wins
  });

  it('throws for an unregistered key', async () => {
    await expect(
      setFeatureFlagOverride('BOGUS_FLAG', true, makeFakeDb(makeFakeOverridesCollection([]))),
    ).rejects.toThrow('Unknown feature flag');
  });

  it('throws when enabled is not a boolean', async () => {
    await expect(
      setFeatureFlagOverride('ARCHIVE_MATERIAL', 'yes', makeFakeDb(makeFakeOverridesCollection([]))),
    ).rejects.toThrow('enabled must be a boolean');
    await expect(
      setFeatureFlagOverride('ARCHIVE_MATERIAL', 1, makeFakeDb(makeFakeOverridesCollection([]))),
    ).rejects.toThrow('enabled must be a boolean');
  });
});

// ─── clearFeatureFlagOverride ─────────────────────────────────────────────────

describe('clearFeatureFlagOverride', () => {
  it('removes an existing override and returns true', async () => {
    const col = makeFakeOverridesCollection([
      { key: 'ARCHIVE_MATERIAL', enabled: false, updatedBy: 'oncall' },
    ]);
    const removed = await clearFeatureFlagOverride('ARCHIVE_MATERIAL', makeFakeDb(col));

    expect(removed).toBe(true);
    expect(col.docs).toHaveLength(0);
  });

  it('returns false when no override existed (safe no-op)', async () => {
    const col = makeFakeOverridesCollection([]);
    const removed = await clearFeatureFlagOverride('ARCHIVE_MATERIAL', makeFakeDb(col));

    expect(removed).toBe(false);
  });

  it('throws for an unregistered key', async () => {
    await expect(
      clearFeatureFlagOverride('BOGUS', makeFakeDb(makeFakeOverridesCollection([]))),
    ).rejects.toThrow('Unknown feature flag');
  });
});

// ─── listFeatureFlagsResolved ─────────────────────────────────────────────────

describe('listFeatureFlagsResolved', () => {
  it('returns one entry per registered flag', async () => {
    const db = makeFakeDb(makeFakeOverridesCollection([]));
    const flags = await listFeatureFlagsResolved(db);

    expect(flags).toHaveLength(Object.keys(FEATURE_FLAG_REGISTRY).length);
    for (const flag of flags) {
      expect(flag).toHaveProperty('key');
      expect(flag).toHaveProperty('enabled');
      expect(flag).toHaveProperty('source');
      expect(flag).toHaveProperty('description');
    }
  });

  it('entries with DB overrides report source:override', async () => {
    const db = makeFakeDb(makeFakeOverridesCollection([
      { key: 'ARCHIVE_MATERIAL', enabled: true, updatedBy: 'ops', reason: 'GA launch' },
    ]));
    const flags = await listFeatureFlagsResolved(db);
    const archiveFlag = flags.find((f) => f.key === 'ARCHIVE_MATERIAL');

    expect(archiveFlag.source).toBe('override');
    expect(archiveFlag.enabled).toBe(true);
    expect(archiveFlag.overriddenBy).toBe('ops');
  });

  it('entries without overrides report env or default source', async () => {
    delete process.env.FEATURE_FLAG_ARCHIVE_MATERIAL;
    const db = makeFakeDb(makeFakeOverridesCollection([]));
    const flags = await listFeatureFlagsResolved(db);
    const archiveFlag = flags.find((f) => f.key === 'ARCHIVE_MATERIAL');

    expect(['env', 'default']).toContain(archiveFlag.source);
    expect(archiveFlag.enabled).toBe(false); // safe default
  });
});

// ─── withFeatureGuard ────────────────────────────────────────────────────────

vi.mock('@/lib/mongodb', () => ({ getDb: vi.fn() }));
vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({ body, status: init?.status ?? 200 })),
  },
}));

import { getDb } from '@/lib/mongodb';
import { NextResponse } from 'next/server';

function makeRequest() {
  return { method: 'POST', headers: { get: () => null } };
}

describe('withFeatureGuard', () => {
  it('throws at wrap time for an unknown flag key', () => {
    expect(() => withFeatureGuard('TOTALLY_UNKNOWN', async () => {})).toThrow('Unknown feature flag');
  });

  it('passes through to handler when flag is enabled via env', async () => {
    process.env.FEATURE_FLAG_ARCHIVE_MATERIAL = 'true';
    getDb.mockResolvedValue(makeFakeDb(makeFakeOverridesCollection([])));

    const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    const guarded = withFeatureGuard('ARCHIVE_MATERIAL', handler);
    const res = await guarded(makeRequest(), {});

    expect(handler).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it('returns 503 FEATURE_DISABLED when flag is disabled via env (no override)', async () => {
    delete process.env.FEATURE_FLAG_ARCHIVE_MATERIAL; // default = false
    getDb.mockResolvedValue(makeFakeDb(makeFakeOverridesCollection([])));

    const handler = vi.fn();
    const guarded = withFeatureGuard('ARCHIVE_MATERIAL', handler);
    await guarded(makeRequest(), {});

    expect(handler).not.toHaveBeenCalled();
    const [body, init] = NextResponse.json.mock.calls[0];
    expect(init.status).toBe(503);
    expect(body.error.code).toBe('FEATURE_DISABLED');
    expect(body.error.retryable).toBe(false);
  });

  it('returns 503 via DB override even when env var enables the flag', async () => {
    process.env.FEATURE_FLAG_ARCHIVE_MATERIAL = 'true'; // env says on
    getDb.mockResolvedValue(makeFakeDb(makeFakeOverridesCollection([
      { key: 'ARCHIVE_MATERIAL', enabled: false, updatedBy: 'oncall', reason: 'incident' },
    ])));

    const handler = vi.fn();
    const guarded = withFeatureGuard('ARCHIVE_MATERIAL', handler);
    await guarded(makeRequest(), {});

    expect(handler).not.toHaveBeenCalled();
    const [, init] = NextResponse.json.mock.calls[0];
    expect(init.status).toBe(503);
  });

  it('falls back to env value when getDb throws — handler called if env enables', async () => {
    process.env.FEATURE_FLAG_ARCHIVE_MATERIAL = 'true';
    getDb.mockRejectedValue(new Error('DB down'));

    const handler = vi.fn(async () => ({ status: 200 }));
    const guarded = withFeatureGuard('ARCHIVE_MATERIAL', handler);
    const res = await guarded(makeRequest(), {});

    expect(handler).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it('falls back to safe default when getDb throws and no env var set', async () => {
    delete process.env.FEATURE_FLAG_ARCHIVE_MATERIAL; // default = false
    getDb.mockRejectedValue(new Error('DB down'));

    const handler = vi.fn();
    const guarded = withFeatureGuard('ARCHIVE_MATERIAL', handler);
    await guarded(makeRequest(), {});

    expect(handler).not.toHaveBeenCalled();
    const [, init] = NextResponse.json.mock.calls[0];
    expect(init.status).toBe(503);
  });
});

// ─── Admin API route — unit tests ────────────────────────────────────────────

vi.mock('@/lib/api/auth', () => ({ requirePermission: vi.fn() }));
vi.mock('@/lib/api/audit', () => ({ auditLog: vi.fn() }));
vi.mock('@/lib/api/hardening', () => ({
  withApiHardening: vi.fn((_req, _opts, handler) => handler()),
}));

import { requirePermission } from '@/lib/api/auth';
import { GET as adminGet, POST as adminPost } from '../../app/api/admin/feature-flags/route.js';

function makeAdminRequest(body = null, method = 'GET') {
  return {
    method,
    headers: { get: () => null },
    json: async () => body,
    url: 'http://localhost/api/admin/feature-flags',
  };
}

describe('Admin API GET /api/admin/feature-flags', () => {
  it('normal path — returns all flags to an authenticated admin', async () => {
    requirePermission.mockResolvedValue({ ok: true, user: { sub: 'admin-1', role: 'admin' } });
    getDb.mockResolvedValue(makeFakeDb(makeFakeOverridesCollection([])));

    const res = await adminGet(makeAdminRequest(null, 'GET'));
    expect(res.status).toBe(200);
    expect(res.body.flags).toHaveLength(Object.keys(FEATURE_FLAG_REGISTRY).length);
  });

  it('auth path — 401 for unauthenticated callers', async () => {
    requirePermission.mockResolvedValue({ ok: false, status: 401 });

    const res = await adminGet(makeAdminRequest(null, 'GET'));
    expect(res.status).toBe(401);
  });

  it('auth path — 403 for authenticated but non-admin callers', async () => {
    requirePermission.mockResolvedValue({ ok: false, status: 403 });

    const res = await adminGet(makeAdminRequest(null, 'GET'));
    expect(res.status).toBe(403);
  });

  it('DB unavailable — returns env/default values with a warning', async () => {
    requirePermission.mockResolvedValue({ ok: true, user: { sub: 'admin-1', role: 'admin' } });
    getDb.mockRejectedValue(new Error('DB down'));

    const res = await adminGet(makeAdminRequest(null, 'GET'));
    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/DB unavailable/);
    expect(res.body.flags).toHaveLength(Object.keys(FEATURE_FLAG_REGISTRY).length);
    expect(res.body.flags.every((f) => typeof f.enabled === 'boolean')).toBe(true);
  });
});

describe('Admin API POST /api/admin/feature-flags', () => {
  it('normal path — enables a flag and returns updated state', async () => {
    requirePermission.mockResolvedValue({ ok: true, user: { sub: 'admin-1', role: 'admin' } });
    const col = makeFakeOverridesCollection([]);
    getDb.mockResolvedValue(makeFakeDb(col));

    const res = await adminPost(
      makeAdminRequest({ key: 'ARCHIVE_MATERIAL', enabled: true, reason: 'beta rollout' }, 'POST'),
    );
    expect(res.status).toBe(200);
    expect(res.body.flag.key).toBe('ARCHIVE_MATERIAL');
    expect(col.docs[0].enabled).toBe(true);
    expect(col.docs[0].reason).toBe('beta rollout');
  });

  it('emergency disable — disables a running flag and returns updated state', async () => {
    requirePermission.mockResolvedValue({ ok: true, user: { sub: 'oncall', role: 'admin' } });
    const col = makeFakeOverridesCollection([{ key: 'ARCHIVE_MATERIAL', enabled: true }]);
    getDb.mockResolvedValue(makeFakeDb(col));

    const res = await adminPost(
      makeAdminRequest({ key: 'ARCHIVE_MATERIAL', enabled: false, reason: 'P1 incident' }, 'POST'),
    );
    expect(res.status).toBe(200);
    expect(col.docs[0].enabled).toBe(false);
    expect(col.docs[0].reason).toBe('P1 incident');
  });

  it('clear override — reverts flag to env/default', async () => {
    requirePermission.mockResolvedValue({ ok: true, user: { sub: 'admin-1', role: 'admin' } });
    const col = makeFakeOverridesCollection([{ key: 'ARCHIVE_MATERIAL', enabled: false }]);
    getDb.mockResolvedValue(makeFakeDb(col));

    const res = await adminPost(
      makeAdminRequest({ key: 'ARCHIVE_MATERIAL', clear: true, reason: 'incident resolved' }, 'POST'),
    );
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
    expect(col.docs).toHaveLength(0);
  });

  it('idempotent — repeated emergency disable is a safe no-op', async () => {
    requirePermission.mockResolvedValue({ ok: true, user: { sub: 'oncall', role: 'admin' } });
    const col = makeFakeOverridesCollection([]);
    const db = makeFakeDb(col);
    getDb.mockResolvedValue(db);

    const body = { key: 'ARCHIVE_MATERIAL', enabled: false, reason: 'incident' };
    const r1 = await adminPost(makeAdminRequest(body, 'POST'));
    const r2 = await adminPost(makeAdminRequest(body, 'POST'));

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(col.docs).toHaveLength(1); // upsert, not two inserts
    expect(col.docs[0].enabled).toBe(false);
  });

  it('failure path — 400 for unknown flag key', async () => {
    requirePermission.mockResolvedValue({ ok: true, user: { sub: 'admin-1', role: 'admin' } });
    getDb.mockResolvedValue(makeFakeDb(makeFakeOverridesCollection([])));

    const res = await adminPost(
      makeAdminRequest({ key: 'DOES_NOT_EXIST', enabled: false }, 'POST'),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown feature flag/);
  });

  it('failure path — 400 when key field is missing', async () => {
    requirePermission.mockResolvedValue({ ok: true, user: { sub: 'admin-1', role: 'admin' } });
    getDb.mockResolvedValue(makeFakeDb(makeFakeOverridesCollection([])));

    const res = await adminPost(makeAdminRequest({ enabled: false }, 'POST'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/key is required/);
  });

  it('failure path — 400 when neither enabled nor clear:true is provided', async () => {
    requirePermission.mockResolvedValue({ ok: true, user: { sub: 'admin-1', role: 'admin' } });
    getDb.mockResolvedValue(makeFakeDb(makeFakeOverridesCollection([])));

    const res = await adminPost(
      makeAdminRequest({ key: 'ARCHIVE_MATERIAL' }, 'POST'),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/enabled.*clear/);
  });

  it('auth path — 401 for unauthenticated callers', async () => {
    requirePermission.mockResolvedValue({ ok: false, status: 401 });

    const res = await adminPost(
      makeAdminRequest({ key: 'ARCHIVE_MATERIAL', enabled: false }, 'POST'),
    );
    expect(res.status).toBe(401);
  });

  it('auth path — 403 for non-admin callers', async () => {
    requirePermission.mockResolvedValue({ ok: false, status: 403 });

    const res = await adminPost(
      makeAdminRequest({ key: 'ARCHIVE_MATERIAL', enabled: false }, 'POST'),
    );
    expect(res.status).toBe(403);
  });

  it('retry path — 503 retryable when DB unavailable on write', async () => {
    requirePermission.mockResolvedValue({ ok: true, user: { sub: 'oncall', role: 'admin' } });
    getDb.mockRejectedValue(new Error('connection reset'));

    const res = await adminPost(
      makeAdminRequest({ key: 'ARCHIVE_MATERIAL', enabled: false, reason: 'incident' }, 'POST'),
    );
    expect(res.status).toBe(503);
    expect(res.body.retryable).toBe(true);
  });
});

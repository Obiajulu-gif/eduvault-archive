/**
 * tests/backend/rollback-external-side-effects.test.mjs
 *
 * Deterministic rollback tests for failed external side effects — Issue #1091.
 *
 * External side effects (webhook delivery, email, IPFS unpin, outbox dispatch)
 * must leave the system in a known, recoverable state whenever they fail.
 * These tests verify:
 *   - Normal path: effect executes fully, outcome recorded.
 *   - Failure path: transient and permanent failures dead-letter cleanly.
 *   - Retry path: retries exhaust before dead-lettering; completed steps
 *     are never re-executed.
 *   - Authorization path: unauthorized dispatches are rejected before any
 *     side-effect handler runs.
 *   - Rollback path: a replay of a dead-lettered effect picks up only
 *     unfinished steps (idempotent replay).
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  createSideEffectDispatcher,
  createMemorySideEffectStore,
  EffectStatus,
  PermanentSideEffectError,
  IdempotencyConflictError,
} from '../../src/lib/sideEffects/dispatcher.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeDispatcher(handlers, overrides = {}) {
  return createSideEffectDispatcher({
    store: createMemorySideEffectStore(),
    config: {
      maxAttempts: 3,
      leaseMs: 5_000,
      initialBackoffMs: 1,
      maxBackoffMs: 10,
      backoffMultiplier: 2,
      ...overrides,
    },
    handlers,
  });
}

const noop = async () => {};

// ─── Normal path ──────────────────────────────────────────────────────────

describe('rollback and side-effect delivery — normal path (#1091)', () => {
  it('dispatches a simple effect and records SUCCEEDED status', async () => {
    let called = false;
    const dispatcher = makeDispatcher({
      email: async (ctx) => {
        called = true;
        await ctx.step('send', async () => ({ sent: true }));
      },
    });

    const result = await dispatcher.dispatch({
      key: 'email:welcome:user-1',
      type: 'email',
      payload: { to: 'user@example.com' },
    });

    assert.equal(result.status, EffectStatus.SUCCEEDED);
    assert.ok(called);
  });

  it('records each completed step individually', async () => {
    const steps = [];
    const dispatcher = makeDispatcher({
      webhook: async (ctx) => {
        await ctx.step('step-a', async () => { steps.push('a'); return 'a'; });
        await ctx.step('step-b', async () => { steps.push('b'); return 'b'; });
      },
    });

    await dispatcher.dispatch({ key: 'wh:1', type: 'webhook', payload: {} });

    assert.deepEqual(steps, ['a', 'b']);
  });

  it('dispatching the same key twice returns duplicate:true', async () => {
    const dispatcher = makeDispatcher({ email: async (ctx) => { await ctx.step('s', noop); } });
    const effect = { key: 'email:dup:1', type: 'email', payload: {} };

    await dispatcher.dispatch(effect);
    const second = await dispatcher.dispatch(effect);

    assert.equal(second.duplicate, true);
    assert.equal(second.status, EffectStatus.SUCCEEDED);
  });
});

// ─── Failure path ─────────────────────────────────────────────────────────

describe('rollback and side-effect delivery — failure path (#1091)', () => {
  it('dead-letters an effect whose handler throws every attempt', async () => {
    const dispatcher = makeDispatcher(
      { email: async () => { throw new Error('smtp down'); } },
      { maxAttempts: 2 },
    );

    const result = await dispatcher.dispatch({
      key: 'email:fail:1',
      type: 'email',
      payload: {},
    });

    assert.equal(result.status, EffectStatus.DEAD_LETTER);
  });

  it('dead-letters immediately when handler throws a PermanentSideEffectError', async () => {
    let calls = 0;
    const dispatcher = makeDispatcher({
      webhook: async () => {
        calls++;
        throw new PermanentSideEffectError('endpoint removed', 'ENDPOINT_GONE');
      },
    });

    const result = await dispatcher.dispatch({
      key: 'wh:perm:1',
      type: 'webhook',
      payload: {},
    });

    assert.equal(result.status, EffectStatus.DEAD_LETTER);
    // permanent errors must not be retried
    assert.equal(calls, 1);
  });

  it('records error details in the dead-letter record', async () => {
    const dispatcher = makeDispatcher(
      { ipfs: async () => { throw new Error('pin timeout'); } },
      { maxAttempts: 1 },
    );

    const result = await dispatcher.dispatch({
      key: 'ipfs:unpin:1',
      type: 'ipfs',
      payload: {},
    });

    assert.equal(result.status, EffectStatus.DEAD_LETTER);
    const history = result.history ?? result.record?.history ?? [];
    const failEntry = history.find((h) => h.error);
    assert.ok(failEntry, 'expected a history entry with an error');
    assert.ok(failEntry.error.message.includes('pin timeout'));
  });

  it('leaves no orphaned in-progress leases after a handler crash', async () => {
    const store = createMemorySideEffectStore();
    const dispatcher = createSideEffectDispatcher({
      store,
      config: { maxAttempts: 1, leaseMs: 5_000, initialBackoffMs: 1, maxBackoffMs: 10 },
      handlers: {
        outbox: async () => { throw new Error('crash'); },
      },
    });

    const key = 'outbox:crash:1';
    await dispatcher.dispatch({ key, type: 'outbox', payload: {} });

    const record = await store.findByKey(key);
    assert.notEqual(record?.status, EffectStatus.IN_PROGRESS);
  });
});

// ─── Retry path ───────────────────────────────────────────────────────────

describe('rollback and side-effect delivery — retry path (#1091)', () => {
  it('retries a transient failure and succeeds on the final attempt', async () => {
    let calls = 0;
    const dispatcher = makeDispatcher({
      email: async (ctx) => {
        calls++;
        if (calls < 3) throw new Error('temporary smtp error');
        await ctx.step('send', noop);
      },
    });

    const result = await dispatcher.dispatch({
      key: 'email:retry:1',
      type: 'email',
      payload: {},
    });

    assert.equal(result.status, EffectStatus.SUCCEEDED);
    assert.equal(calls, 3);
  });

  it('never re-runs a step that already completed on a previous attempt', async () => {
    const stepRuns = { 'url-a': 0, 'url-b': 0 };
    let attempt = 0;

    const dispatcher = makeDispatcher({
      webhook: async (ctx) => {
        attempt++;
        await ctx.step('url-a', async () => { stepRuns['url-a']++; });
        // Fail on the first attempt after completing step url-a
        if (attempt === 1) throw new Error('transient on second step');
        await ctx.step('url-b', async () => { stepRuns['url-b']++; });
      },
    });

    const result = await dispatcher.dispatch({
      key: 'wh:step-idempotency:1',
      type: 'webhook',
      payload: {},
    });

    assert.equal(result.status, EffectStatus.SUCCEEDED);
    // url-a must only run once despite two handler invocations
    assert.equal(stepRuns['url-a'], 1, 'url-a should not be re-run on retry');
    assert.equal(stepRuns['url-b'], 1);
  });

  it('exhausts maxAttempts and transitions to DEAD_LETTER', async () => {
    const dispatcher = makeDispatcher(
      { webhook: async () => { throw new Error('always fails'); } },
      { maxAttempts: 3 },
    );

    const result = await dispatcher.dispatch({
      key: 'wh:exhaust:1',
      type: 'webhook',
      payload: {},
    });

    assert.equal(result.status, EffectStatus.DEAD_LETTER);
  });
});

// ─── Authorization path ───────────────────────────────────────────────────

describe('rollback and side-effect delivery — authorization path (#1091)', () => {
  it('dispatches normally with an authorized principal', async () => {
    let ran = false;
    const dispatcher = createSideEffectDispatcher({
      store: createMemorySideEffectStore(),
      config: { maxAttempts: 1 },
      handlers: {
        email: async (ctx) => {
          ran = true;
          await ctx.step('send', noop);
        },
      },
      authorize: async (principal) => principal?.role === 'system',
    });

    const result = await dispatcher.dispatch(
      { key: 'email:auth:ok', type: 'email', payload: {} },
      { principal: { id: 'svc-1', role: 'system' } },
    );

    assert.equal(result.status, EffectStatus.SUCCEEDED);
    assert.ok(ran);
  });

  it('rejects an unauthorized principal before the handler runs', async () => {
    let ran = false;
    const dispatcher = createSideEffectDispatcher({
      store: createMemorySideEffectStore(),
      config: { maxAttempts: 1 },
      handlers: {
        email: async (ctx) => {
          ran = true;
          await ctx.step('send', noop);
        },
      },
      authorize: async (principal) => principal?.role === 'system',
    });

    await assert.rejects(
      () =>
        dispatcher.dispatch(
          { key: 'email:auth:denied', type: 'email', payload: {} },
          { principal: { id: 'u-1', role: 'viewer' } },
        ),
      (err) => err.code === 'DISPATCH_UNAUTHORIZED' || err.status === 403 || err.message?.includes('authorized'),
    );

    assert.equal(ran, false);
  });
});

// ─── Rollback / replay path ───────────────────────────────────────────────

describe('rollback and side-effect delivery — replay path (#1091)', () => {
  it('replayDeadLetter re-runs only incomplete steps', async () => {
    const delivered = [];
    let downstream = false;

    const dispatcher = makeDispatcher({
      webhook: async (ctx) => {
        for (const url of ['https://ok.example.com', 'https://flaky.example.com']) {
          await ctx.step(url, async () => {
            if (url.includes('flaky') && !downstream) throw new Error('503 upstream');
            delivered.push(url);
          });
        }
      },
    });

    // First dispatch — flaky URL will fail and dead-letter
    const first = await dispatcher.dispatch({
      key: 'wh:replay:1',
      type: 'webhook',
      payload: { urls: ['https://ok.example.com', 'https://flaky.example.com'] },
    });
    assert.equal(first.status, EffectStatus.DEAD_LETTER);
    assert.deepEqual(delivered, ['https://ok.example.com']);

    // Downstream recovers; operator replays
    downstream = true;
    const replay = await dispatcher.replayDeadLetter('wh:replay:1', {
      operator: 'ops-team',
      reason: 'flaky URL recovered',
    });

    assert.equal(replay.record.status, EffectStatus.SUCCEEDED);
    // ok URL must NOT be delivered again
    assert.deepEqual(delivered, ['https://ok.example.com', 'https://flaky.example.com']);
  });

  it('dispatching the same key after replay returns duplicate:true', async () => {
    let calls = 0;
    const dispatcher = makeDispatcher(
      {
        email: async (ctx) => {
          calls++;
          if (calls < 2) throw new Error('transient');
          await ctx.step('send', noop);
        },
      },
      { maxAttempts: 1 },
    );

    const key = 'email:post-replay:1';
    await dispatcher.dispatch({ key, type: 'email', payload: {} });
    await dispatcher.replayDeadLetter(key, { operator: 'ops', reason: 'retry' });

    const third = await dispatcher.dispatch({ key, type: 'email', payload: {} });
    assert.equal(third.duplicate, true);
  });

  it('replayDeadLetter preserves audit trail with operator and reason', async () => {
    const dispatcher = makeDispatcher(
      { email: async () => { throw new Error('always fails'); } },
      { maxAttempts: 1 },
    );

    await dispatcher.dispatch({ key: 'email:audit:1', type: 'email', payload: {} });

    const replay = await dispatcher.replayDeadLetter('email:audit:1', {
      operator: 'alice',
      reason: 'manual retry after outage',
    });

    const history = replay.record?.history ?? [];
    const replayEntry = history.find(
      (h) => h.operator === 'alice' || h.reason?.includes('manual retry'),
    );
    // The dispatcher should record who triggered the replay
    assert.ok(
      replayEntry != null || replay.record?.replayedBy === 'alice',
      'expected audit entry for replay operator',
    );
  });

  it('replayDeadLetter throws if key does not exist', async () => {
    const dispatcher = makeDispatcher({ email: noop });

    await assert.rejects(
      () => dispatcher.replayDeadLetter('no-such-key', { operator: 'ops', reason: 'test' }),
      (err) => err.code != null || err.message != null,
    );
  });
});

// ─── Idempotency conflict path ────────────────────────────────────────────

describe('rollback and side-effect delivery — idempotency conflict (#1091)', () => {
  it('rejects reuse of an idempotency key with a different payload', async () => {
    const dispatcher = makeDispatcher({
      email: async (ctx) => { await ctx.step('s', noop); },
    });

    await dispatcher.dispatch({
      key: 'email:conflict:1',
      type: 'email',
      payload: { to: 'a@example.com' },
    });

    await assert.rejects(
      () =>
        dispatcher.dispatch({
          key: 'email:conflict:1',
          type: 'email',
          payload: { to: 'b@example.com' }, // different payload
        }),
      (err) => err instanceof IdempotencyConflictError || err.code === 'IDEMPOTENCY_CONFLICT',
    );
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────

describe('rollback and side-effect delivery — edge cases (#1091)', () => {
  it('stats() returns counts for all statuses', async () => {
    const dispatcher = makeDispatcher(
      {
        email: async (ctx) => { await ctx.step('s', noop); },
        webhook: async () => { throw new Error('fail'); },
      },
      { maxAttempts: 1 },
    );

    await dispatcher.dispatch({ key: 'e:1', type: 'email', payload: {} });
    await dispatcher.dispatch({ key: 'w:1', type: 'webhook', payload: {} });

    const s = dispatcher.stats();
    assert.ok(s[EffectStatus.SUCCEEDED] >= 1);
    assert.ok(s[EffectStatus.DEAD_LETTER] >= 1);
  });

  it('a handler with no steps still records SUCCEEDED', async () => {
    const dispatcher = makeDispatcher({
      noop: async () => { /* no ctx.step calls */ },
    });

    const result = await dispatcher.dispatch({ key: 'noop:1', type: 'noop', payload: {} });
    assert.equal(result.status, EffectStatus.SUCCEEDED);
  });
});

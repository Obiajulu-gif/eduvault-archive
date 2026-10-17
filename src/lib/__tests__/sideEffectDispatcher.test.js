import { describe, expect, it, vi } from 'vitest';
import {
  EffectStatus,
  IdempotencyConflictError,
  PermanentSideEffectError,
  createMemorySideEffectStore,
  createSideEffectDispatcher,
} from '../sideEffects/dispatcher.js';

function manualClock(start = '2026-10-01T00:00:00.000Z') {
  let now = new Date(start).getTime();
  return {
    clock: () => new Date(now),
    advance: (ms) => {
      now += ms;
    },
  };
}

describe('side-effect dispatcher (#945)', () => {
  it('runs a keyed effect once and suppresses duplicate dispatches', async () => {
    const send = vi.fn(async () => ({ messageId: 'm-1' }));
    const events = [];
    const dispatcher = createSideEffectDispatcher({
      handlers: { email: (ctx) => ctx.step('send', () => send(ctx.payload)) },
      onEvent: (e) => events.push(e.event),
    });

    const first = await dispatcher.dispatch({ key: 'receipt:pur-1', type: 'email', payload: { to: 'x' } });
    const second = await dispatcher.dispatch({ key: 'receipt:pur-1', type: 'email', payload: { to: 'x' } });

    expect(first).toMatchObject({ status: EffectStatus.SUCCEEDED, executed: true, duplicate: false });
    expect(second).toMatchObject({ status: EffectStatus.SUCCEEDED, executed: false, duplicate: true });
    expect(second.result).toEqual({ messageId: 'm-1' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(events).toEqual(
      expect.arrayContaining(['enqueued', 'attempt_started', 'step_completed', 'succeeded', 'duplicate_suppressed'])
    );
  });

  it('rejects reuse of a key with a different payload', async () => {
    const dispatcher = createSideEffectDispatcher({ handlers: { email: async () => 'ok' } });
    await dispatcher.dispatch({ key: 'k1', type: 'email', payload: { a: 1, b: 2 } });
    // Same payload with different key order is the same effect.
    await expect(dispatcher.dispatch({ key: 'k1', type: 'email', payload: { b: 2, a: 1 } })).resolves.toMatchObject({
      duplicate: true,
    });
    await expect(dispatcher.dispatch({ key: 'k1', type: 'email', payload: { a: 2 } })).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );
  });

  it('validates keys and handler types up front', async () => {
    const dispatcher = createSideEffectDispatcher({ handlers: { email: async () => 'ok' } });
    await expect(dispatcher.dispatch({ key: '', type: 'email' })).rejects.toThrow(/key/);
    await expect(dispatcher.dispatch({ key: 'bad key with spaces', type: 'email' })).rejects.toThrow(/key/);
    await expect(dispatcher.dispatch({ key: 'k', type: 'sms' })).rejects.toThrow(/No handler/);
    expect(() => createSideEffectDispatcher({})).toThrow(/handlers/);
  });

  it('retries transient failures with backoff without repeating completed steps', async () => {
    const { clock, advance } = manualClock();
    const delivered = [];
    let failOnce = true;
    const dispatcher = createSideEffectDispatcher({
      clock,
      config: { initialBackoffMs: 1000 },
      handlers: {
        webhook: async (ctx) => {
          for (const url of ctx.payload.urls) {
            await ctx.step(`deliver:${url}`, async () => {
              if (url === 'https://b.example' && failOnce) {
                failOnce = false;
                throw new Error('ECONNRESET');
              }
              delivered.push(url);
              return { url };
            });
          }
          return { delivered: ctx.payload.urls.length };
        },
      },
    });

    const effect = { key: 'webhook:pur-9', type: 'webhook', payload: { urls: ['https://a.example', 'https://b.example'] } };
    const first = await dispatcher.dispatch(effect);
    expect(first.status).toBe(EffectStatus.RETRY_SCHEDULED);
    expect(first.record.lastError).toMatchObject({ message: 'ECONNRESET', retryable: true });

    // Not due yet.
    expect(await dispatcher.processDue()).toEqual([]);
    advance(1000);
    const [retried] = await dispatcher.processDue();
    expect(retried.status).toBe(EffectStatus.SUCCEEDED);
    expect(delivered).toEqual(['https://a.example', 'https://b.example']); // a delivered exactly once
    expect(retried.record.attempts).toBe(2);
  });

  it('dead-letters permanent errors immediately and exhausted retries after maxAttempts', async () => {
    const { clock, advance } = manualClock();
    const dispatcher = createSideEffectDispatcher({
      clock,
      config: { maxAttempts: 3, initialBackoffMs: 10, maxBackoffMs: 10 },
      handlers: {
        permanent: async () => {
          throw new PermanentSideEffectError('recipient unsubscribed', 'UNSUBSCRIBED');
        },
        flaky: async () => {
          throw new Error('timeout');
        },
      },
    });

    const perm = await dispatcher.dispatch({ key: 'p1', type: 'permanent' });
    expect(perm.status).toBe(EffectStatus.DEAD_LETTER);
    expect(perm.record.attempts).toBe(1);
    expect(perm.record.history.at(-1)).toMatchObject({ event: 'dead_lettered', reason: 'permanent_error' });

    await dispatcher.dispatch({ key: 'f1', type: 'flaky' });
    for (let i = 0; i < 5; i += 1) {
      advance(10);
      await dispatcher.processDue();
    }
    const flaky = await dispatcher.getRecord('f1');
    expect(flaky.status).toBe(EffectStatus.DEAD_LETTER);
    expect(flaky.attempts).toBe(3);
    expect(flaky.history.at(-1).reason).toBe('max_attempts_exceeded');

    expect((await dispatcher.listDeadLetters()).map((r) => r.key).sort()).toEqual(['f1', 'p1']);
    expect(await dispatcher.stats()).toMatchObject({ dead_letter: 2, succeeded: 0 });
  });

  it('replays a dead letter with audit metadata and never repeats delivered steps', async () => {
    const sent = [];
    let providerDown = true;
    const dispatcher = createSideEffectDispatcher({
      config: { maxAttempts: 1 },
      handlers: {
        payoutNotice: async (ctx) => {
          await ctx.step('notify-creator', async (idem) => sent.push(`creator:${idem}`));
          await ctx.step('notify-admin', async () => {
            if (providerDown) throw new Error('smtp down');
            sent.push('admin');
          });
          return 'done';
        },
      },
    });

    const failed = await dispatcher.dispatch({ key: 'payout:42', type: 'payoutNotice' });
    expect(failed.status).toBe(EffectStatus.DEAD_LETTER);

    await expect(dispatcher.replayDeadLetter('payout:42', { reason: 'x' })).rejects.toThrow(/operator/);
    await expect(dispatcher.replayDeadLetter('payout:42', { operator: 'ops-1' })).rejects.toThrow(/reason/);
    expect(await dispatcher.replayDeadLetter('missing', { operator: 'ops-1', reason: 'x' })).toEqual({
      outcome: 'not_found',
    });

    providerDown = false;
    const replay = await dispatcher.replayDeadLetter('payout:42', { operator: 'ops-1', reason: 'SMTP restored' });
    expect(replay.outcome).toBe('replayed');
    expect(replay.record.status).toBe(EffectStatus.SUCCEEDED);
    expect(replay.record.replayCount).toBe(1);
    expect(replay.record.history.find((h) => h.event === 'replayed')).toMatchObject({
      operator: 'ops-1',
      reason: 'SMTP restored',
      previousError: 'smtp down',
    });
    expect(sent).toEqual(['creator:payout:42:notify-creator', 'admin']);

    const again = await dispatcher.replayDeadLetter('payout:42', { operator: 'ops-1', reason: 'oops' });
    expect(again.outcome).toBe('not_dead_letter');
  });

  it('runs the handler once when two workers dispatch the same key concurrently', async () => {
    const store = createMemorySideEffectStore();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => {
      await gate;
      return 'ok';
    });
    const a = createSideEffectDispatcher({ store, workerId: 'a', handlers: { email: handler } });
    const b = createSideEffectDispatcher({ store, workerId: 'b', handlers: { email: handler } });

    const pa = a.dispatch({ key: 'race', type: 'email' });
    const pb = b.dispatch({ key: 'race', type: 'email' });
    const second = await pb;
    expect(second).toMatchObject({ duplicate: true, executed: false, status: EffectStatus.IN_PROGRESS });
    release();
    expect((await pa).status).toBe(EffectStatus.SUCCEEDED);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('recovers an expired lease after a crash and fences the stale worker', async () => {
    const { clock, advance } = manualClock();
    const store = createMemorySideEffectStore();
    const sends = [];
    let releaseStale;
    const stalled = new Promise((resolve) => {
      releaseStale = resolve;
    });

    const stale = createSideEffectDispatcher({
      store,
      clock,
      workerId: 'stale',
      config: { leaseMs: 1000 },
      handlers: {
        email: async (ctx) => {
          await ctx.step('render', async () => 'html');
          await stalled; // worker hangs (GC pause, network partition...)
          return ctx.step('send', async () => sends.push('stale'));
        },
      },
    });
    const fresh = createSideEffectDispatcher({
      store,
      clock,
      workerId: 'fresh',
      config: { leaseMs: 1000 },
      handlers: {
        email: async (ctx) => {
          await ctx.step('render', async () => {
            throw new Error('render should have been skipped');
          });
          return ctx.step('send', async () => sends.push('fresh'));
        },
      },
    });

    const stalePromise = stale.dispatch({ key: 'crash-1', type: 'email' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    advance(1001); // lease expired

    const [taken] = await fresh.processDue();
    expect(taken.status).toBe(EffectStatus.SUCCEEDED);

    releaseStale();
    const staleResult = await stalePromise;
    // The stale worker cannot record its step or overwrite the outcome.
    expect(staleResult.status).toBe(EffectStatus.SUCCEEDED);
    expect((await store.get('crash-1')).history.at(-1)).toMatchObject({ event: 'succeeded', workerId: 'fresh' });
    expect(sends).toEqual(['fresh']);
  });

  it('keeps dispatch outcomes stable when the observability hook throws', async () => {
    const dispatcher = createSideEffectDispatcher({
      handlers: { email: async () => 'ok' },
      onEvent: () => {
        throw new Error('metrics backend down');
      },
    });
    await expect(dispatcher.dispatch({ key: 'obs', type: 'email' })).resolves.toMatchObject({
      status: EffectStatus.SUCCEEDED,
    });
  });
});

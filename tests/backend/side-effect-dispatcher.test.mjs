import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EffectStatus, createSideEffectDispatcher } from '../../src/lib/sideEffects/dispatcher.js';

// Idempotent side-effect dispatcher (#945).
describe('side-effect dispatcher (#945)', () => {
  it('delivers once, dead-letters, and replays without duplicating delivered steps', async () => {
    const delivered = [];
    let downstreamUp = false;
    const dispatcher = createSideEffectDispatcher({
      config: { maxAttempts: 1 },
      handlers: {
        webhook: async (ctx) => {
          for (const url of ctx.payload.urls) {
            await ctx.step(url, async () => {
              if (url.includes('flaky') && !downstreamUp) throw new Error('503');
              delivered.push(url);
            });
          }
        },
      },
    });
    const effect = { key: 'purchase:1:webhook', type: 'webhook', payload: { urls: ['https://ok', 'https://flaky'] } };

    assert.equal((await dispatcher.dispatch(effect)).status, EffectStatus.DEAD_LETTER);
    downstreamUp = true;
    const replay = await dispatcher.replayDeadLetter(effect.key, { operator: 'ops', reason: 'downstream recovered' });
    assert.equal(replay.record.status, EffectStatus.SUCCEEDED);
    assert.equal((await dispatcher.dispatch(effect)).duplicate, true);
    assert.deepEqual(delivered, ['https://ok', 'https://flaky']);
  });
});

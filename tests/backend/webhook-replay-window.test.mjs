/**
 * tests/backend/webhook-replay-window.test.mjs
 *
 * Automated tests for signed webhook replay-window enforcement (issue #1096).
 * Covers normal, failure, retry, and authorization paths as specified in the
 * acceptance criteria.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  createReplayWindowEnforcer,
  ReplayWindowViolationError,
  createWebhookSignatureHeader,
  verifyWebhookSignature,
  clearWebhookReplayCache,
} from '../../src/lib/webhooks/sender.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

const SECRET = 'test-signing-secret-abc123';
const BODY = JSON.stringify({ event: 'purchase.completed', materialId: 'm-1' });

function makeHeader(body, secret, ts) {
  return createWebhookSignatureHeader(body, secret, ts);
}

// ─── Normal path ──────────────────────────────────────────────────────────

describe('replay-window enforcer — normal path (#1096)', () => {
  it('accepts a fresh, correctly signed payload', () => {
    const NOW = 1_000_000;
    const enforcer = createReplayWindowEnforcer({ now: () => NOW });
    const header = makeHeader(BODY, SECRET, NOW);

    assert.equal(enforcer.verify(BODY, header, SECRET), true);
    assert.equal(enforcer.stats().accepted, 1);
  });

  it('accepts a payload right at the edge of the window (window - 1s)', () => {
    const NOW = 1_000_000;
    const WINDOW = 300;
    const enforcer = createReplayWindowEnforcer({ replayWindowSeconds: WINDOW, now: () => NOW });

    const header = makeHeader(BODY, SECRET, NOW - WINDOW + 1);
    assert.equal(enforcer.verify(BODY, header, SECRET), true);
  });

  it('accepts different payloads with different signatures in the same window', () => {
    const NOW = 1_000_000;
    const enforcer = createReplayWindowEnforcer({ now: () => NOW });

    const body1 = JSON.stringify({ id: 'a' });
    const body2 = JSON.stringify({ id: 'b' });

    assert.equal(enforcer.verify(body1, makeHeader(body1, SECRET, NOW), SECRET), true);
    assert.equal(enforcer.verify(body2, makeHeader(body2, SECRET, NOW), SECRET), true);
    assert.equal(enforcer.stats().accepted, 2);
  });

  it('allows the same body after the window expires (clock advances)', () => {
    let nowSec = 1_000_000;
    const enforcer = createReplayWindowEnforcer({ replayWindowSeconds: 60, now: () => nowSec });

    const header = makeHeader(BODY, SECRET, nowSec);
    enforcer.verify(BODY, header, SECRET);

    // Advance clock past the window
    nowSec += 61;
    // A new signature (different timestamp) is fresh — must be accepted
    const newHeader = makeHeader(BODY, SECRET, nowSec);
    assert.equal(enforcer.verify(BODY, newHeader, SECRET), true);
  });
});

// ─── Failure / rejection path ─────────────────────────────────────────────

describe('replay-window enforcer — failure path (#1096)', () => {
  it('throws ReplayWindowViolationError for a replayed signature', () => {
    const NOW = 1_000_000;
    const enforcer = createReplayWindowEnforcer({ now: () => NOW });
    const header = makeHeader(BODY, SECRET, NOW);

    enforcer.verify(BODY, header, SECRET);

    assert.throws(
      () => enforcer.verify(BODY, header, SECRET),
      (err) =>
        err instanceof ReplayWindowViolationError &&
        err.code === 'REPLAY_WINDOW_VIOLATION' &&
        err.reason.includes('replayed'),
    );
    assert.equal(enforcer.stats().rejectedReplay, 1);
  });

  it('throws ReplayWindowViolationError for a past-dated payload beyond the window', () => {
    const NOW = 1_000_000;
    const WINDOW = 300;
    const enforcer = createReplayWindowEnforcer({ replayWindowSeconds: WINDOW, now: () => NOW });

    const staleHeader = makeHeader(BODY, SECRET, NOW - WINDOW - 1);
    assert.throws(
      () => enforcer.verify(BODY, staleHeader, SECRET),
      (err) => err instanceof ReplayWindowViolationError && err.reason.includes('window'),
    );
    assert.equal(enforcer.stats().rejectedExpired, 1);
  });

  it('throws ReplayWindowViolationError for a future-dated payload beyond the window', () => {
    const NOW = 1_000_000;
    const WINDOW = 300;
    const enforcer = createReplayWindowEnforcer({ replayWindowSeconds: WINDOW, now: () => NOW });

    const futureHeader = makeHeader(BODY, SECRET, NOW + WINDOW + 1);
    assert.throws(
      () => enforcer.verify(BODY, futureHeader, SECRET),
      (err) => err instanceof ReplayWindowViolationError,
    );
    assert.equal(enforcer.stats().rejectedExpired, 1);
  });

  it('throws ReplayWindowViolationError for a tampered body', () => {
    const NOW = 1_000_000;
    const enforcer = createReplayWindowEnforcer({ now: () => NOW });

    const header = makeHeader(BODY, SECRET, NOW);
    const tamperedBody = JSON.stringify({ event: 'purchase.completed', materialId: 'INJECTED' });

    assert.throws(
      () => enforcer.verify(tamperedBody, header, SECRET),
      (err) => err instanceof ReplayWindowViolationError && err.reason.includes('mismatch'),
    );
  });

  it('throws ReplayWindowViolationError for a wrong secret', () => {
    const NOW = 1_000_000;
    const enforcer = createReplayWindowEnforcer({ now: () => NOW });

    const header = makeHeader(BODY, SECRET, NOW);
    assert.throws(
      () => enforcer.verify(BODY, header, 'wrong-secret'),
      (err) => err instanceof ReplayWindowViolationError,
    );
  });

  it('throws ReplayWindowViolationError for a malformed signature header', () => {
    const NOW = 1_000_000;
    const enforcer = createReplayWindowEnforcer({ now: () => NOW });

    assert.throws(
      () => enforcer.verify(BODY, 'not-a-valid-header', SECRET),
      (err) => err instanceof ReplayWindowViolationError && err.reason.includes('malformed'),
    );
    assert.equal(enforcer.stats().rejectedMalformed, 1);
  });

  it('throws ReplayWindowViolationError when body is missing', () => {
    const NOW = 1_000_000;
    const enforcer = createReplayWindowEnforcer({ now: () => NOW });
    const header = makeHeader(BODY, SECRET, NOW);

    assert.throws(
      () => enforcer.verify('', header, SECRET),
      (err) => err instanceof ReplayWindowViolationError,
    );
  });

  it('throws ReplayWindowViolationError when signature header is missing', () => {
    const NOW = 1_000_000;
    const enforcer = createReplayWindowEnforcer({ now: () => NOW });

    assert.throws(
      () => enforcer.verify(BODY, '', SECRET),
      (err) => err instanceof ReplayWindowViolationError,
    );
  });

  it('throws ReplayWindowViolationError when secret is missing', () => {
    const NOW = 1_000_000;
    const enforcer = createReplayWindowEnforcer({ now: () => NOW });
    const header = makeHeader(BODY, SECRET, NOW);

    assert.throws(
      () => enforcer.verify(BODY, header, ''),
      (err) => err instanceof ReplayWindowViolationError,
    );
  });
});

// ─── Configurable window sizes ────────────────────────────────────────────

describe('replay-window enforcer — configurable window (#1096)', () => {
  it('honours a tight 60-second window', () => {
    const NOW = 1_000_000;
    const enforcer = createReplayWindowEnforcer({ replayWindowSeconds: 60, now: () => NOW });

    // 59s old — within 60s window
    assert.equal(enforcer.verify(BODY, makeHeader(BODY, SECRET, NOW - 59), SECRET), true);

    enforcer.clear();
    // 61s old — outside 60s window
    assert.throws(
      () => enforcer.verify(BODY, makeHeader(BODY, SECRET, NOW - 61), SECRET),
      (err) => err instanceof ReplayWindowViolationError,
    );
  });

  it('honours a wide 3600-second window', () => {
    const NOW = 1_000_000;
    const enforcer = createReplayWindowEnforcer({ replayWindowSeconds: 3600, now: () => NOW });

    const oldHeader = makeHeader(BODY, SECRET, NOW - 3599);
    assert.equal(enforcer.verify(BODY, oldHeader, SECRET), true);
  });

  it('two separate enforcers with different windows are independent', () => {
    const NOW = 1_000_000;
    const tight = createReplayWindowEnforcer({ replayWindowSeconds: 60, now: () => NOW });
    const wide = createReplayWindowEnforcer({ replayWindowSeconds: 600, now: () => NOW });

    const headerAt90sAgo = makeHeader(BODY, SECRET, NOW - 90);

    // tight: 90s > 60s window → rejected
    assert.throws(
      () => tight.verify(BODY, headerAt90sAgo, SECRET),
      (err) => err instanceof ReplayWindowViolationError,
    );

    // wide: 90s < 600s window → accepted
    assert.equal(wide.verify(BODY, headerAt90sAgo, SECRET), true);
  });
});

// ─── Observability and cache management ──────────────────────────────────

describe('replay-window enforcer — stats and cache (#1096)', () => {
  it('stats() returns all counters', () => {
    const NOW = 1_000_000;
    const enforcer = createReplayWindowEnforcer({ now: () => NOW });

    enforcer.verify(BODY, makeHeader(BODY, SECRET, NOW), SECRET);
    try { enforcer.verify(BODY, makeHeader(BODY, SECRET, NOW), SECRET); } catch {}

    const s = enforcer.stats();
    assert.ok('accepted' in s);
    assert.ok('rejectedReplay' in s);
    assert.ok('rejectedExpired' in s);
    assert.ok('rejectedMalformed' in s);
    assert.ok('cacheSize' in s);
    assert.ok('replayWindowSeconds' in s);
    assert.equal(s.accepted, 1);
    assert.equal(s.rejectedReplay, 1);
  });

  it('clear() resets all counters and empties the cache', () => {
    const NOW = 1_000_000;
    const enforcer = createReplayWindowEnforcer({ now: () => NOW });

    enforcer.verify(BODY, makeHeader(BODY, SECRET, NOW), SECRET);
    enforcer.clear();

    const s = enforcer.stats();
    assert.equal(s.accepted, 0);
    assert.equal(s.cacheSize, 0);
  });

  it('evicts expired signatures on the next verify call', () => {
    let nowSec = 1_000_000;
    const WINDOW = 10;
    const enforcer = createReplayWindowEnforcer({ replayWindowSeconds: WINDOW, now: () => nowSec });

    enforcer.verify(BODY, makeHeader(BODY, SECRET, nowSec), SECRET);
    assert.equal(enforcer.stats().cacheSize, 1);

    // Advance past expiry
    nowSec += WINDOW + 1;
    // Trigger eviction with a fresh verify
    const newBody = JSON.stringify({ id: 'fresh' });
    enforcer.verify(newBody, makeHeader(newBody, SECRET, nowSec), SECRET);
    assert.equal(enforcer.stats().cacheSize, 1); // only the fresh one remains
  });
});

// ─── Configuration validation ─────────────────────────────────────────────

describe('replay-window enforcer — configuration (#1096)', () => {
  it('throws TypeError for a zero or negative replayWindowSeconds', () => {
    assert.throws(() => createReplayWindowEnforcer({ replayWindowSeconds: 0 }), TypeError);
    assert.throws(() => createReplayWindowEnforcer({ replayWindowSeconds: -1 }), TypeError);
  });

  it('throws TypeError for a non-numeric replayWindowSeconds', () => {
    assert.throws(() => createReplayWindowEnforcer({ replayWindowSeconds: 'big' }), TypeError);
  });
});

// ─── Compatibility: existing verifyWebhookSignature still works ───────────

describe('replay-window enforcer — existing verifyWebhookSignature compatibility (#1096)', () => {
  beforeEach(() => {
    clearWebhookReplayCache();
  });

  it('existing verifyWebhookSignature still accepts a fresh payload', () => {
    const NOW = 1_000_000;
    const header = makeHeader(BODY, SECRET, NOW);
    assert.equal(verifyWebhookSignature(BODY, header, SECRET, { now: NOW }), true);
  });

  it('existing verifyWebhookSignature still rejects replays', () => {
    const NOW = 1_000_000;
    const header = makeHeader(BODY, SECRET, NOW);

    assert.equal(verifyWebhookSignature(BODY, header, SECRET, { now: NOW }), true);
    assert.equal(verifyWebhookSignature(BODY, header, SECRET, { now: NOW + 1 }), false);
  });
});

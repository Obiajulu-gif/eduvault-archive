import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyRateLimitHeaders,
  buildBlockedBody,
  CheckoutAbuseController,
  extractClientIp,
  parseCheckoutControlMode,
  verifyCheckoutActor,
} from '../../src/lib/checkout/checkoutAbuseControl.js';

const WALLET_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const WALLET_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const WALLET_C = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function makeController() {
  return new CheckoutAbuseController({
    purchase: {
      windowMs: 60_000,
      maxWalletRequests: 3,
      maxIpRequests: 5,
      targetWindowMs: 60_000,
      maxTargetRequests: 2,
      maxDistinctWalletsPerIp: 3,
      maxConsecutiveFailures: 3,
      baseCooldownMs: 30_000,
      maxCooldownMs: 120_000,
      maxIdempotentRetries: 2,
      txReplayWindowMs: 300_000,
    },
    refund: {
      windowMs: 60_000,
      maxWalletRequests: 2,
      maxIpRequests: 5,
      targetWindowMs: 60_000,
      maxTargetRequests: 2,
      maxDistinctWalletsPerIp: 3,
      maxConsecutiveFailures: 2,
      baseCooldownMs: 30_000,
      maxCooldownMs: 60_000,
      maxIdempotentRetries: 2,
      txReplayWindowMs: 60_000,
    },
    verify_promo: {
      windowMs: 60_000,
      maxWalletRequests: 5,
      maxIpRequests: 4,
      targetWindowMs: 60_000,
      maxTargetRequests: 4,
      maxDistinctWalletsPerIp: 5,
      maxConsecutiveFailures: 3,
      baseCooldownMs: 30_000,
      maxCooldownMs: 60_000,
      maxIdempotentRetries: 2,
      txReplayWindowMs: 60_000,
    },
  });
}

test('normal path: allows checkout mutations within quota and isolates wallets/IPs', () => {
  const controller = makeController();
  const t0 = 1_700_000_000_000;

  const d1 = controller.evaluate(
    { mutation: 'purchase', wallet: WALLET_A, ip: '198.51.100.1', target: 'mat-1', now: t0 },
    'enforce'
  );
  assert.equal(d1.allowed, true);
  assert.equal(d1.headers.limit, 3);
  assert.equal(d1.headers.remaining, 2);

  const d2 = controller.evaluate(
    { mutation: 'purchase', wallet: WALLET_B, ip: '198.51.100.2', target: 'mat-1', now: t0 + 100 },
    'enforce'
  );
  assert.equal(d2.allowed, true);
  assert.equal(d2.headers.remaining, 2);
});

test('failure path: enforces per-wallet rate limit and recovers after sliding window expires', () => {
  const controller = makeController();
  const t0 = 1_700_000_000_000;

  for (let i = 0; i < 3; i++) {
    const res = controller.evaluate(
      { mutation: 'purchase', wallet: WALLET_A, ip: '198.51.100.1', target: `mat-${i}`, now: t0 + i * 1_000 },
      'enforce'
    );
    assert.equal(res.allowed, true);
  }

  const blocked = controller.evaluate(
    { mutation: 'purchase', wallet: WALLET_A, ip: '198.51.100.1', target: 'mat-3', now: t0 + 5_000 },
    'enforce'
  );
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.code, 'CHECKOUT_RATE_LIMIT_EXCEEDED');
  assert.equal(blocked.dimension, 'wallet');
  assert.ok(blocked.headers.retryAfterSec > 0);

  // Retry after window expires succeeds cleanly
  const recovered = controller.evaluate(
    { mutation: 'purchase', wallet: WALLET_A, ip: '198.51.100.1', target: 'mat-4', now: t0 + 61_000 },
    'enforce'
  );
  assert.equal(recovered.allowed, true);
});

test('failure path: enforces per-target burst limit before wallet limit is exhausted', () => {
  const controller = makeController();
  const t0 = 1_700_000_000_000;

  assert.equal(
    controller.evaluate(
      { mutation: 'purchase', wallet: WALLET_A, ip: '198.51.100.1', target: 'hot-mat', now: t0 },
      'enforce'
    ).allowed,
    true
  );
  assert.equal(
    controller.evaluate(
      { mutation: 'purchase', wallet: WALLET_A, ip: '198.51.100.1', target: 'hot-mat', now: t0 + 500 },
      'enforce'
    ).allowed,
    true
  );

  const third = controller.evaluate(
    { mutation: 'purchase', wallet: WALLET_A, ip: '198.51.100.1', target: 'hot-mat', now: t0 + 1_000 },
    'enforce'
  );
  assert.equal(third.allowed, false);
  assert.equal(third.statusCode, 429);
  assert.equal(third.dimension, 'target');
});

test('failure path: enforces per-IP limit across multiple wallets sharing one IP', () => {
  const controller = makeController();
  const t0 = 1_700_000_000_000;
  const sharedIp = '198.51.100.99';

  const calls = [
    { wallet: WALLET_A, target: 'm1' },
    { wallet: WALLET_A, target: 'm2' },
    { wallet: WALLET_B, target: 'm3' },
    { wallet: WALLET_B, target: 'm4' },
    { wallet: WALLET_C, target: 'm5' },
  ];
  for (let i = 0; i < calls.length; i++) {
    assert.equal(
      controller.evaluate(
        { mutation: 'purchase', ip: sharedIp, ...calls[i], now: t0 + i * 100 },
        'enforce'
      ).allowed,
      true
    );
  }

  const sixth = controller.evaluate(
    { mutation: 'purchase', wallet: WALLET_C, ip: sharedIp, target: 'm6', now: t0 + 1_000 },
    'enforce'
  );
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.statusCode, 429);
  assert.equal(sixth.dimension, 'ip');
});

test('abuse path: detects IP-to-wallet fan-in abuse', () => {
  const controller = makeController();
  const t0 = 1_700_000_000_000;
  const sharedIp = '203.0.113.55';

  for (let i = 0; i < 3; i++) {
    assert.equal(
      controller.evaluate(
        { mutation: 'purchase', wallet: `G_WALLET_${i}`, ip: sharedIp, target: `t${i}`, now: t0 + i * 100 },
        'enforce'
      ).allowed,
      true
    );
  }

  const fourth = controller.evaluate(
    { mutation: 'purchase', wallet: 'G_WALLET_3', ip: sharedIp, target: 't3', now: t0 + 500 },
    'enforce'
  );
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.statusCode, 403);
  assert.equal(fourth.code, 'CHECKOUT_ABUSE_DETECTED');
});

test('abuse path: blocks self-dealing and cross-wallet txHash replay', () => {
  const controller = makeController();
  const t0 = 1_700_000_000_000;

  const selfDeal = controller.evaluate(
    {
      mutation: 'purchase',
      wallet: WALLET_A,
      counterparty: WALLET_A.toLowerCase(),
      ip: '198.51.100.1',
      target: 'm1',
      now: t0,
    },
    'enforce'
  );
  assert.equal(selfDeal.allowed, false);
  assert.equal(selfDeal.statusCode, 403);
  assert.equal(selfDeal.code, 'CHECKOUT_SELF_DEALING_BLOCKED');

  assert.equal(
    controller.evaluate(
      {
        mutation: 'purchase',
        wallet: WALLET_A,
        ip: '198.51.100.1',
        target: 'm1',
        txHash: 'tx_stellar_001',
        idempotencyKey: 'idem-tx-1',
        now: t0,
      },
      'enforce'
    ).allowed,
    true
  );

  // Same wallet retrying with same txHash and idempotencyKey succeeds
  const sameWalletRetry = controller.evaluate(
    {
      mutation: 'purchase',
      wallet: WALLET_A,
      ip: '198.51.100.1',
      target: 'm1',
      txHash: 'tx_stellar_001',
      idempotencyKey: 'idem-tx-1',
      now: t0 + 500,
    },
    'enforce'
  );
  assert.equal(sameWalletRetry.allowed, true);
  assert.equal(sameWalletRetry.idempotentRetry, true);

  // Different wallet replaying the same txHash is blocked
  const replay = controller.evaluate(
    {
      mutation: 'purchase',
      wallet: WALLET_B,
      ip: '198.51.100.2',
      target: 'm1',
      txHash: 'tx_stellar_001',
      now: t0 + 1_000,
    },
    'enforce'
  );
  assert.equal(replay.allowed, false);
  assert.equal(replay.statusCode, 403);
  assert.equal(replay.code, 'CHECKOUT_TX_REPLAY_DETECTED');
});

test('retry path: idempotent retries do not double-charge quota, but retry storms are capped', () => {
  const controller = makeController();
  const t0 = 1_700_000_000_000;

  const initial = controller.evaluate(
    {
      mutation: 'purchase',
      wallet: WALLET_A,
      ip: '198.51.100.1',
      target: 'm1',
      idempotencyKey: 'idem-key-1',
      now: t0,
    },
    'enforce'
  );
  assert.equal(initial.allowed, true);
  assert.equal(initial.headers.remaining, 2);

  for (let r = 1; r <= 2; r++) {
    const retry = controller.evaluate(
      {
        mutation: 'purchase',
        wallet: WALLET_A,
        ip: '198.51.100.1',
        target: 'm1',
        idempotencyKey: 'idem-key-1',
        now: t0 + r * 500,
      },
      'enforce'
    );
    assert.equal(retry.allowed, true);
    assert.equal(retry.idempotentRetry, true);
  }

  // 3rd retry exceeds maxIdempotentRetries (2)
  const storm = controller.evaluate(
    {
      mutation: 'purchase',
      wallet: WALLET_A,
      ip: '198.51.100.1',
      target: 'm1',
      idempotencyKey: 'idem-key-1',
      now: t0 + 2_000,
    },
    'enforce'
  );
  assert.equal(storm.allowed, false);
  assert.equal(storm.statusCode, 429);
  assert.equal(storm.dimension, 'idempotent_retry');

  // Distinct checkout still has 2 remaining wallet slots
  const fresh = controller.evaluate(
    {
      mutation: 'purchase',
      wallet: WALLET_A,
      ip: '198.51.100.1',
      target: 'm2',
      idempotencyKey: 'idem-key-2',
      now: t0 + 2_500,
    },
    'enforce'
  );
  assert.equal(fresh.allowed, true);
  assert.equal(fresh.headers.remaining, 1);
});

test('failure streak cooldown: activates exponential backoff on consecutive failures and clears on success', () => {
  const controller = makeController();
  const t0 = 1_700_000_000_000;

  controller.recordOutcome({ mutation: 'verify_promo', ip: '198.51.100.7', now: t0 }, false);
  controller.recordOutcome({ mutation: 'verify_promo', ip: '198.51.100.7', now: t0 + 100 }, false);
  controller.recordOutcome({ mutation: 'verify_promo', ip: '198.51.100.7', now: t0 + 200 }, false);

  const cooled = controller.evaluate(
    { mutation: 'verify_promo', ip: '198.51.100.7', target: 'global', now: t0 + 1_000 },
    'enforce'
  );
  assert.equal(cooled.allowed, false);
  assert.equal(cooled.statusCode, 429);
  assert.equal(cooled.code, 'CHECKOUT_COOLDOWN_ACTIVE');
  assert.ok(cooled.headers.retryAfterSec >= 29);

  // After 30s cooldown expires, success clears the streak
  const resumed = controller.evaluate(
    { mutation: 'verify_promo', ip: '198.51.100.7', target: 'global', now: t0 + 31_000 },
    'enforce'
  );
  assert.equal(resumed.allowed, true);
  controller.recordOutcome({ mutation: 'verify_promo', ip: '198.51.100.7', now: t0 + 31_100 }, true);

  // Single subsequent failure does not immediately re-trigger cooldown
  controller.recordOutcome({ mutation: 'verify_promo', ip: '198.51.100.7', now: t0 + 32_000 }, false);
  assert.equal(
    controller.evaluate(
      { mutation: 'verify_promo', ip: '198.51.100.7', target: 'global', now: t0 + 32_500 },
      'enforce'
    ).allowed,
    true
  );
});

test('authorization path: verifies actor and rejects wallet spoofing before quota consumption', () => {
  const unauth = verifyCheckoutActor({ user: null, claimedWallet: WALLET_A, requireAuth: true });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.status, 401);
  assert.equal(unauth.code, 'CHECKOUT_AUTH_REQUIRED');

  const spoofed = verifyCheckoutActor({
    user: { walletAddress: WALLET_B, role: 'user' },
    claimedWallet: WALLET_A,
    requireAuth: true,
  });
  assert.equal(spoofed.ok, false);
  assert.equal(spoofed.status, 403);
  assert.equal(spoofed.code, 'CHECKOUT_WALLET_MISMATCH');

  const valid = verifyCheckoutActor({
    user: { walletAddress: WALLET_A, role: 'user' },
    claimedWallet: WALLET_A.toLowerCase(),
    requireAuth: true,
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.wallet, WALLET_A.toLowerCase());

  // Admin may act on behalf of another buyer wallet
  const adminOk = verifyCheckoutActor({
    user: { walletAddress: WALLET_B, role: 'admin' },
    claimedWallet: WALLET_A,
    requireAuth: true,
  });
  assert.equal(adminOk.ok, true);
});

test('rollout & recovery: supports shadow mode, off mode instant rollback, scoped reset, and headers', () => {
  const controller = makeController();
  const t0 = 1_700_000_000_000;

  assert.equal(parseCheckoutControlMode(undefined), 'enforce');
  assert.equal(parseCheckoutControlMode('shadow'), 'shadow');
  assert.equal(parseCheckoutControlMode('OFF'), 'off');

  // Shadow mode records event without blocking
  const shadow = controller.evaluate(
    { mutation: 'purchase', wallet: WALLET_A, counterparty: WALLET_A, ip: '1.1.1.1', target: 'm1', now: t0 },
    'shadow'
  );
  assert.equal(shadow.allowed, true);
  assert.equal(shadow.wouldBlock, true);
  assert.equal(controller.getEvents({ mutation: 'purchase' }).total, 1);

  // Off mode bypasses immediately
  const off = controller.evaluate(
    { mutation: 'purchase', wallet: WALLET_A, counterparty: WALLET_A, ip: '1.1.1.1', target: 'm1', now: t0 + 100 },
    'off'
  );
  assert.equal(off.allowed, true);
  assert.equal(off.wouldBlock, false);

  // Scoped reset clears WALLET_A cooldown without affecting WALLET_B
  for (let i = 0; i < 3; i++) {
    controller.recordOutcome({ mutation: 'purchase', wallet: WALLET_A, ip: '1.1.1.1', now: t0 }, false);
    controller.recordOutcome({ mutation: 'purchase', wallet: WALLET_B, ip: '2.2.2.2', now: t0 }, false);
  }
  controller.reset({ wallet: WALLET_A });

  assert.equal(
    controller.evaluate(
      { mutation: 'purchase', wallet: WALLET_A, ip: '1.1.1.1', target: 'm1', now: t0 + 1_000 },
      'enforce'
    ).allowed,
    true
  );
  const blockedB = controller.evaluate(
    { mutation: 'purchase', wallet: WALLET_B, ip: '2.2.2.2', target: 'm1', now: t0 + 1_000 },
    'enforce'
  );
  assert.equal(blockedB.allowed, false);

  // Header & body helpers produce standard rate-limit headers and structured payload
  const fakeRes = { headers: new Headers() };
  applyRateLimitHeaders(fakeRes, blockedB);
  assert.equal(fakeRes.headers.get('X-RateLimit-Remaining'), '0');
  assert.ok(Number(fakeRes.headers.get('Retry-After')) > 0);
  const body = buildBlockedBody(blockedB, 'purchase');
  assert.equal(body.code, 'CHECKOUT_COOLDOWN_ACTIVE');
  assert.equal(body.mutation, 'purchase');
  assert.ok(body.remedy);

  // IP extraction helper parses x-forwarded-for cleanly
  const req = new Request('http://localhost:3000/api/purchase', {
    headers: { 'x-forwarded-for': '203.0.113.42, 10.0.0.1' },
  });
  assert.equal(extractClientIp(req), '203.0.113.42');
});

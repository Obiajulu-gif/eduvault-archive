/**
 * Rate limits and abuse controls for EduVault checkout mutations (#1188).
 *
 * Protects checkout mutations (`purchase`, `initiate`, `verify`, `refund`,
 * `verify_promo`) with:
 *   1. Multi-dimensional sliding-window rate limits:
 *      - per-wallet / per-actor limit
 *      - per-IP limit (catches multi-wallet rotation from a single origin)
 *      - per-target burst limit per wallet/IP (catches hammering a single item)
 *   2. Abuse controls:
 *      - consecutive failure-streak exponential cooldown (resets on success)
 *      - IP-to-wallet fan-in detection (many distinct wallets from one IP)
 *      - self-dealing detection (buyer === creator/counterparty)
 *      - cross-wallet transaction hash replay detection
 *   3. Safe idempotent retry handling:
 *      - retries carrying the same idempotency key for the same mutation,
 *        wallet, and target do not double-charge rate-limit quotas (up to a
 *        bounded retry cap so retry storms cannot bypass limits).
 *   4. Authorization pre-check helper:
 *      - rejects unauthenticated or wallet-mismatched callers before any
 *        rate-limit quota is consumed.
 *   5. Rollout & instant rollback via `CHECKOUT_ABUSE_CONTROL_MODE`:
 *      - `enforce` (default): enforces limits and abuse blocks
 *      - `shadow`: evaluates and records telemetry, never blocks
 *      - `off`: instant rollback / no-op
 *
 * Runbook: docs/CHECKOUT_RATE_LIMITS_AND_ABUSE_CONTROLS.md
 */

import { createHash } from 'node:crypto';

export const CHECKOUT_MUTATIONS = Object.freeze([
  'purchase',
  'initiate',
  'verify',
  'refund',
  'verify_promo',
]);

export const CHECKOUT_BLOCK_CODES = Object.freeze([
  'CHECKOUT_RATE_LIMIT_EXCEEDED',
  'CHECKOUT_COOLDOWN_ACTIVE',
  'CHECKOUT_ABUSE_DETECTED',
  'CHECKOUT_SELF_DEALING_BLOCKED',
  'CHECKOUT_TX_REPLAY_DETECTED',
]);

export const DEFAULT_CHECKOUT_POLICIES = Object.freeze({
  purchase: Object.freeze({
    windowMs: 60_000,
    maxWalletRequests: 10,
    maxIpRequests: 25,
    targetWindowMs: 60_000,
    maxTargetRequests: 5,
    maxDistinctWalletsPerIp: 6,
    maxConsecutiveFailures: 5,
    baseCooldownMs: 30_000,
    maxCooldownMs: 15 * 60_000,
    maxIdempotentRetries: 5,
    txReplayWindowMs: 15 * 60_000,
  }),
  initiate: Object.freeze({
    windowMs: 60_000,
    maxWalletRequests: 12,
    maxIpRequests: 30,
    targetWindowMs: 60_000,
    maxTargetRequests: 5,
    maxDistinctWalletsPerIp: 6,
    maxConsecutiveFailures: 5,
    baseCooldownMs: 30_000,
    maxCooldownMs: 15 * 60_000,
    maxIdempotentRetries: 5,
    txReplayWindowMs: 15 * 60_000,
  }),
  verify: Object.freeze({
    windowMs: 60_000,
    maxWalletRequests: 15,
    maxIpRequests: 30,
    targetWindowMs: 60_000,
    maxTargetRequests: 6,
    maxDistinctWalletsPerIp: 6,
    maxConsecutiveFailures: 4,
    baseCooldownMs: 60_000,
    maxCooldownMs: 15 * 60_000,
    maxIdempotentRetries: 5,
    txReplayWindowMs: 15 * 60_000,
  }),
  refund: Object.freeze({
    windowMs: 5 * 60_000,
    maxWalletRequests: 5,
    maxIpRequests: 15,
    targetWindowMs: 5 * 60_000,
    maxTargetRequests: 3,
    maxDistinctWalletsPerIp: 5,
    maxConsecutiveFailures: 4,
    baseCooldownMs: 60_000,
    maxCooldownMs: 30 * 60_000,
    maxIdempotentRetries: 5,
    txReplayWindowMs: 15 * 60_000,
  }),
  verify_promo: Object.freeze({
    windowMs: 60_000,
    maxWalletRequests: 10,
    maxIpRequests: 15,
    targetWindowMs: 60_000,
    maxTargetRequests: 5,
    maxDistinctWalletsPerIp: 8,
    maxConsecutiveFailures: 5,
    baseCooldownMs: 60_000,
    maxCooldownMs: 15 * 60_000,
    maxIdempotentRetries: 3,
    txReplayWindowMs: 15 * 60_000,
  }),
});

const MAX_TRACKED_KEYS = 5_000;
const MAX_ABUSE_EVENTS = 500;

export function parseCheckoutControlMode(raw) {
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (normalized === 'off' || normalized === 'shadow' || normalized === 'enforce') {
    return normalized;
  }
  return 'enforce';
}

export function hashIdentifier(value) {
  return createHash('sha256')
    .update(String(value || '').trim().toLowerCase())
    .digest('hex')
    .slice(0, 24);
}

export function extractClientIp(request) {
  if (!request?.headers) return 'unknown';
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get('x-real-ip')?.trim();
  return realIp || 'unknown';
}

function normalizeWalletId(wallet) {
  if (typeof wallet !== 'string') return undefined;
  const trimmed = wallet.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIp(ip) {
  const trimmed = typeof ip === 'string' ? ip.trim() : '';
  return trimmed.length > 0 ? trimmed : 'unknown';
}

function pruneWindow(timestamps, cutoff) {
  let idx = 0;
  while (idx < timestamps.length && timestamps[idx] <= cutoff) {
    idx += 1;
  }
  return idx === 0 ? timestamps : timestamps.slice(idx);
}

function evictIfNeeded(map, maxEntries = MAX_TRACKED_KEYS) {
  if (map.size < maxEntries) return;
  const oldestKey = map.keys().next().value;
  if (oldestKey !== undefined) {
    map.delete(oldestKey);
  }
}

/**
 * Verifies checkout actor authorization before rate-limit accounting runs, so
 * unauthenticated or spoofed callers cannot drain another buyer's quota.
 */
export function verifyCheckoutActor({ user, claimedWallet, requireAuth = false } = {}) {
  if (requireAuth && !user) {
    return {
      ok: false,
      status: 401,
      code: 'CHECKOUT_AUTH_REQUIRED',
      error: 'Authentication is required for this checkout mutation.',
    };
  }

  const sessionWallet = normalizeWalletId(
    user?.walletAddress || user?.address || user?.publicKey || ''
  );
  const bodyWallet = normalizeWalletId(claimedWallet);

  if (sessionWallet && bodyWallet && sessionWallet !== bodyWallet && user?.role !== 'admin') {
    return {
      ok: false,
      status: 403,
      code: 'CHECKOUT_WALLET_MISMATCH',
      error: 'Claimed buyer wallet does not match the authenticated session wallet.',
    };
  }

  return {
    ok: true,
    wallet: sessionWallet || bodyWallet || normalizeWalletId(user?.id || user?.sub || ''),
  };
}

export class CheckoutAbuseController {
  constructor(overrides = {}) {
    this.policies = {};
    for (const mutation of CHECKOUT_MUTATIONS) {
      this.policies[mutation] = {
        ...DEFAULT_CHECKOUT_POLICIES[mutation],
        ...(overrides[mutation] || {}),
      };
    }
    this.walletWindows = new Map();
    this.ipWindows = new Map();
    this.targetWindows = new Map();
    this.ipWallets = new Map();
    this.failureStates = new Map();
    this.idempotentRetries = new Map();
    this.txHashes = new Map();
    this.events = [];
  }

  getPolicy(mutation) {
    return this.policies[mutation] || this.policies.purchase;
  }

  evaluate(ctx, mode = parseCheckoutControlMode(process.env.CHECKOUT_ABUSE_CONTROL_MODE)) {
    const mutation = CHECKOUT_MUTATIONS.includes(ctx.mutation) ? ctx.mutation : 'purchase';
    const now = typeof ctx.now === 'number' ? ctx.now : Date.now();
    const policy = this.getPolicy(mutation);
    const wallet = normalizeWalletId(ctx.wallet);
    const counterparty = normalizeWalletId(ctx.counterparty);
    const ip = normalizeIp(ctx.ip);
    const walletHash = wallet ? hashIdentifier(wallet) : undefined;
    const ipHash = hashIdentifier(ip);

    const defaultHeaders = {
      limit: wallet ? policy.maxWalletRequests : policy.maxIpRequests,
      remaining: wallet ? policy.maxWalletRequests : policy.maxIpRequests,
      resetAtEpochSec: Math.ceil((now + policy.windowMs) / 1000),
    };

    if (mode === 'off') {
      return {
        allowed: true,
        wouldBlock: false,
        mode,
        headers: defaultHeaders,
      };
    }

    const buildBlocked = ({ statusCode, code, dimension, reason, remedy, headers }) => {
      const enforced = mode === 'enforce';
      this._recordEvent({
        timestamp: now,
        mutation,
        mode,
        enforced,
        code,
        dimension,
        walletHash,
        ipHash,
        target: ctx.target || undefined,
        path: ctx.path || '',
        method: ctx.method || 'POST',
        retryAfterSec: headers.retryAfterSec,
        reason,
      });

      return {
        allowed: !enforced,
        wouldBlock: true,
        mode,
        statusCode,
        code,
        dimension,
        reason,
        remedy,
        headers,
      };
    };

    // 1. Self-dealing check (buyer === creator/counterparty)
    if (wallet && counterparty && wallet === counterparty) {
      return buildBlocked({
        statusCode: 403,
        code: 'CHECKOUT_SELF_DEALING_BLOCKED',
        reason: 'Buyer wallet cannot match the creator/counterparty wallet for a checkout mutation.',
        remedy: 'Use a distinct buyer wallet that does not own the target material.',
        headers: defaultHeaders,
      });
    }

    // 2. Active failure-streak exponential cooldown check
    const failureKey = `${mutation}:${walletHash || ipHash}`;
    const failureState = this.failureStates.get(failureKey);
    if (failureState && failureState.cooldownUntil > now) {
      const retryAfterSec = Math.max(1, Math.ceil((failureState.cooldownUntil - now) / 1000));
      return buildBlocked({
        statusCode: 429,
        code: 'CHECKOUT_COOLDOWN_ACTIVE',
        dimension: walletHash ? 'wallet' : 'ip',
        reason: `Checkout temporarily paused after ${failureState.consecutiveFailures} consecutive failed attempts.`,
        remedy: `Wait ${retryAfterSec} seconds before retrying, or contact support to clear a false positive.`,
        headers: {
          limit: defaultHeaders.limit,
          remaining: 0,
          resetAtEpochSec: Math.ceil(failureState.cooldownUntil / 1000),
          retryAfterSec,
        },
      });
    }

    // 3. Cross-wallet transaction hash replay detection
    const normalizedTx = typeof ctx.txHash === 'string' ? ctx.txHash.trim().toLowerCase() : '';
    if (normalizedTx && walletHash) {
      const existingTx = this.txHashes.get(normalizedTx);
      if (existingTx && now - existingTx.seenAt <= policy.txReplayWindowMs) {
        if (existingTx.walletHash !== walletHash) {
          return buildBlocked({
            statusCode: 403,
            code: 'CHECKOUT_TX_REPLAY_DETECTED',
            reason: 'This transaction hash was already submitted by a different wallet.',
            remedy: 'Submit a freshly signed checkout transaction belonging to your own wallet.',
            headers: defaultHeaders,
          });
        }
      }
    }

    // 4. Safe idempotent retry recognition (no double-charge on retries up to cap)
    const idempotencyKey =
      typeof ctx.idempotencyKey === 'string' ? ctx.idempotencyKey.trim() : '';
    if (idempotencyKey) {
      const retryScopeKey = `${mutation}:${walletHash || ipHash}:${ctx.target || '_'}:${hashIdentifier(idempotencyKey)}`;
      const existingRetry = this.idempotentRetries.get(retryScopeKey);
      if (existingRetry && existingRetry.expiresAt > now) {
        if (existingRetry.count >= policy.maxIdempotentRetries) {
          const retryAfterSec = Math.max(1, Math.ceil((existingRetry.expiresAt - now) / 1000));
          return buildBlocked({
            statusCode: 429,
            code: 'CHECKOUT_RATE_LIMIT_EXCEEDED',
            dimension: 'idempotent_retry',
            reason: `Exceeded maximum of ${policy.maxIdempotentRetries} retries for the same Idempotency-Key.`,
            remedy: `Back off and retry after ${retryAfterSec} seconds, or inspect the original checkout status.`,
            headers: {
              limit: policy.maxIdempotentRetries,
              remaining: 0,
              resetAtEpochSec: Math.ceil(existingRetry.expiresAt / 1000),
              retryAfterSec,
            },
          });
        }

        existingRetry.count += 1;
        return {
          allowed: true,
          wouldBlock: false,
          mode,
          idempotentRetry: true,
          headers: {
            limit: policy.maxIdempotentRetries,
            remaining: Math.max(0, policy.maxIdempotentRetries - existingRetry.count),
            resetAtEpochSec: Math.ceil(existingRetry.expiresAt / 1000),
          },
        };
      }
    }

    // 5. IP-to-wallet fan-in detection
    if (walletHash && ip !== 'unknown') {
      let seenWallets = this.ipWallets.get(ipHash);
      if (!seenWallets) {
        evictIfNeeded(this.ipWallets);
        seenWallets = new Map();
        this.ipWallets.set(ipHash, seenWallets);
      }
      const fanInCutoff = now - policy.windowMs;
      for (const [seenWallet, ts] of seenWallets.entries()) {
        if (ts <= fanInCutoff) {
          seenWallets.delete(seenWallet);
        }
      }
      const wouldBeDistinct = seenWallets.has(walletHash)
        ? seenWallets.size
        : seenWallets.size + 1;
      if (wouldBeDistinct > policy.maxDistinctWalletsPerIp) {
        return buildBlocked({
          statusCode: 403,
          code: 'CHECKOUT_ABUSE_DETECTED',
          dimension: 'ip',
          reason: `Detected ${wouldBeDistinct} distinct wallets attempting ${mutation} from one IP within ${Math.round(policy.windowMs / 1000)}s (limit ${policy.maxDistinctWalletsPerIp}).`,
          remedy: 'Wait for the rate window to reset or complete checkout from your own network. Admins can reset false positives via POST /api/admin/checkout-abuse.',
          headers: {
            limit: policy.maxDistinctWalletsPerIp,
            remaining: 0,
            resetAtEpochSec: Math.ceil((now + policy.windowMs) / 1000),
            retryAfterSec: Math.ceil(policy.windowMs / 1000),
          },
        });
      }
    }

    // 6. Sliding-window rate limits: per-IP, per-wallet, per-target
    const windowCutoff = now - policy.windowMs;
    const ipKey = `${mutation}:${ipHash}`;
    const ipTimestamps = pruneWindow(this.ipWindows.get(ipKey) || [], windowCutoff);
    if (ipTimestamps.length >= policy.maxIpRequests) {
      const oldest = ipTimestamps[0];
      const resetAt = oldest + policy.windowMs;
      const retryAfterSec = Math.max(1, Math.ceil((resetAt - now) / 1000));
      this.ipWindows.set(ipKey, ipTimestamps);
      return buildBlocked({
        statusCode: 429,
        code: 'CHECKOUT_RATE_LIMIT_EXCEEDED',
        dimension: 'ip',
        reason: `IP rate limit exceeded for ${mutation} (${policy.maxIpRequests} requests per ${Math.round(policy.windowMs / 1000)}s).`,
        remedy: `Retry after ${retryAfterSec} seconds with the same Idempotency-Key if retrying a prior attempt.`,
        headers: {
          limit: policy.maxIpRequests,
          remaining: 0,
          resetAtEpochSec: Math.ceil(resetAt / 1000),
          retryAfterSec,
        },
      });
    }

    let walletKey;
    let walletTimestamps = [];
    if (walletHash) {
      walletKey = `${mutation}:${walletHash}`;
      walletTimestamps = pruneWindow(this.walletWindows.get(walletKey) || [], windowCutoff);
      if (walletTimestamps.length >= policy.maxWalletRequests) {
        const oldest = walletTimestamps[0];
        const resetAt = oldest + policy.windowMs;
        const retryAfterSec = Math.max(1, Math.ceil((resetAt - now) / 1000));
        this.walletWindows.set(walletKey, walletTimestamps);
        return buildBlocked({
          statusCode: 429,
          code: 'CHECKOUT_RATE_LIMIT_EXCEEDED',
          dimension: 'wallet',
          reason: `Wallet rate limit exceeded for ${mutation} (${policy.maxWalletRequests} requests per ${Math.round(policy.windowMs / 1000)}s).`,
          remedy: `Retry after ${retryAfterSec} seconds. Keep the same Idempotency-Key when retrying an in-flight checkout.`,
          headers: {
            limit: policy.maxWalletRequests,
            remaining: 0,
            resetAtEpochSec: Math.ceil(resetAt / 1000),
            retryAfterSec,
          },
        });
      }
    }

    let targetKey;
    let targetTimestamps = [];
    if (ctx.target) {
      const targetCutoff = now - policy.targetWindowMs;
      targetKey = `${mutation}:${walletHash || ipHash}:${String(ctx.target)}`;
      targetTimestamps = pruneWindow(this.targetWindows.get(targetKey) || [], targetCutoff);
      if (targetTimestamps.length >= policy.maxTargetRequests) {
        const oldest = targetTimestamps[0];
        const resetAt = oldest + policy.targetWindowMs;
        const retryAfterSec = Math.max(1, Math.ceil((resetAt - now) / 1000));
        this.targetWindows.set(targetKey, targetTimestamps);
        return buildBlocked({
          statusCode: 429,
          code: 'CHECKOUT_RATE_LIMIT_EXCEEDED',
          dimension: 'target',
          reason: `Too many ${mutation} attempts for target '${ctx.target}' (${policy.maxTargetRequests} per ${Math.round(policy.targetWindowMs / 1000)}s).`,
          remedy: `Wait ${retryAfterSec} seconds before attempting checkout for this item again.`,
          headers: {
            limit: policy.maxTargetRequests,
            remaining: 0,
            resetAtEpochSec: Math.ceil(resetAt / 1000),
            retryAfterSec,
          },
        });
      }
    }

    // Admitted: record across dimensions.
    ipTimestamps.push(now);
    evictIfNeeded(this.ipWindows);
    this.ipWindows.set(ipKey, ipTimestamps);

    if (walletKey && walletHash) {
      walletTimestamps.push(now);
      evictIfNeeded(this.walletWindows);
      this.walletWindows.set(walletKey, walletTimestamps);

      const seenWallets = this.ipWallets.get(ipHash);
      if (seenWallets) {
        seenWallets.set(walletHash, now);
      }
    }

    if (targetKey) {
      targetTimestamps.push(now);
      evictIfNeeded(this.targetWindows);
      this.targetWindows.set(targetKey, targetTimestamps);
    }

    if (idempotencyKey) {
      const retryScopeKey = `${mutation}:${walletHash || ipHash}:${ctx.target || '_'}:${hashIdentifier(idempotencyKey)}`;
      evictIfNeeded(this.idempotentRetries);
      this.idempotentRetries.set(retryScopeKey, {
        count: 0,
        firstSeenAt: now,
        expiresAt: now + policy.windowMs,
      });
    }

    if (normalizedTx && walletHash) {
      evictIfNeeded(this.txHashes);
      this.txHashes.set(normalizedTx, { walletHash, seenAt: now });
    }

    const activeLimit = walletKey ? policy.maxWalletRequests : policy.maxIpRequests;
    const activeCount = walletKey ? walletTimestamps.length : ipTimestamps.length;
    const activeOldest = walletKey ? walletTimestamps[0] : ipTimestamps[0];

    return {
      allowed: true,
      wouldBlock: false,
      mode,
      headers: {
        limit: activeLimit,
        remaining: Math.max(0, activeLimit - activeCount),
        resetAtEpochSec: Math.ceil((activeOldest + policy.windowMs) / 1000),
      },
    };
  }

  recordOutcome(ctx, succeeded) {
    const mutation = CHECKOUT_MUTATIONS.includes(ctx.mutation) ? ctx.mutation : 'purchase';
    const now = typeof ctx.now === 'number' ? ctx.now : Date.now();
    const policy = this.getPolicy(mutation);
    const wallet = normalizeWalletId(ctx.wallet);
    const subjectHash = wallet ? hashIdentifier(wallet) : hashIdentifier(normalizeIp(ctx.ip));
    const key = `${mutation}:${subjectHash}`;

    if (succeeded) {
      this.failureStates.delete(key);
      return;
    }

    const current = this.failureStates.get(key) || {
      consecutiveFailures: 0,
      cooldownUntil: 0,
      lastFailureAt: now,
    };

    const nextFailures = current.consecutiveFailures + 1;
    let cooldownUntil = current.cooldownUntil;
    if (nextFailures >= policy.maxConsecutiveFailures) {
      const exponent = Math.min(10, nextFailures - policy.maxConsecutiveFailures);
      const duration = Math.min(policy.maxCooldownMs, policy.baseCooldownMs * 2 ** exponent);
      cooldownUntil = now + duration;
    }

    evictIfNeeded(this.failureStates);
    this.failureStates.set(key, {
      consecutiveFailures: nextFailures,
      cooldownUntil,
      lastFailureAt: now,
    });
  }

  getEvents(options = {}) {
    const now = typeof options.now === 'number' ? options.now : Date.now();
    let filtered = [...this.events];

    if (options.mutation) {
      filtered = filtered.filter((e) => e.mutation === options.mutation);
    }
    if (options.code) {
      filtered = filtered.filter((e) => e.code === options.code);
    }
    if (options.sinceMs && options.sinceMs > 0) {
      const cutoff = now - options.sinceMs;
      filtered = filtered.filter((e) => e.timestamp >= cutoff);
    }

    const summaryByCode = {};
    const summaryByMutation = {};
    for (const evt of filtered) {
      summaryByCode[evt.code] = (summaryByCode[evt.code] || 0) + 1;
      summaryByMutation[evt.mutation] = (summaryByMutation[evt.mutation] || 0) + 1;
    }

    const max = options.limit && options.limit > 0 ? options.limit : 100;
    return {
      events: filtered.slice(0, max),
      total: filtered.length,
      summaryByCode,
      summaryByMutation,
    };
  }

  reset(options = {}) {
    const walletNorm = normalizeWalletId(options.wallet);
    const walletHash = walletNorm ? hashIdentifier(walletNorm) : undefined;
    const ipHash = options.ip ? hashIdentifier(normalizeIp(options.ip)) : undefined;
    const mutation = options.mutation;

    if (!walletHash && !ipHash && !mutation) {
      this.walletWindows.clear();
      this.ipWindows.clear();
      this.targetWindows.clear();
      this.ipWallets.clear();
      this.failureStates.clear();
      this.idempotentRetries.clear();
      this.txHashes.clear();
      if (options.clearEvents !== false) {
        this.events.length = 0;
      }
      return;
    }

    const matchesKey = (key) => {
      if (mutation && !key.startsWith(`${mutation}:`)) return false;
      if (walletHash && !key.includes(walletHash)) return false;
      if (ipHash && !key.includes(ipHash)) return false;
      return true;
    };

    for (const key of [...this.walletWindows.keys()]) {
      if (matchesKey(key)) this.walletWindows.delete(key);
    }
    for (const key of [...this.ipWindows.keys()]) {
      if (matchesKey(key)) this.ipWindows.delete(key);
    }
    for (const key of [...this.targetWindows.keys()]) {
      if (matchesKey(key)) this.targetWindows.delete(key);
    }
    for (const key of [...this.failureStates.keys()]) {
      if (matchesKey(key)) this.failureStates.delete(key);
    }
    for (const key of [...this.idempotentRetries.keys()]) {
      if (matchesKey(key)) this.idempotentRetries.delete(key);
    }

    if (ipHash) {
      this.ipWallets.delete(ipHash);
    } else if (walletHash) {
      for (const seen of this.ipWallets.values()) {
        seen.delete(walletHash);
      }
    }

    if (walletHash) {
      for (const [tx, state] of this.txHashes.entries()) {
        if (state.walletHash === walletHash) {
          this.txHashes.delete(tx);
        }
      }
    }
  }

  _recordEvent(event) {
    const fullEvent = {
      ...event,
      id: `chk_evt_${event.timestamp}_${Math.random().toString(36).slice(2, 8)}`,
    };
    this.events.unshift(fullEvent);
    if (this.events.length > MAX_ABUSE_EVENTS) {
      this.events.pop();
    }
  }
}

export function applyRateLimitHeaders(response, decision) {
  if (!response?.headers || !decision?.headers) return response;
  response.headers.set('X-RateLimit-Limit', String(decision.headers.limit));
  response.headers.set('X-RateLimit-Remaining', String(decision.headers.remaining));
  response.headers.set('X-RateLimit-Reset', String(decision.headers.resetAtEpochSec));
  if (decision.mode === 'shadow') {
    response.headers.set('X-Checkout-Abuse-Mode', 'shadow');
  }
  if (!decision.allowed && decision.headers.retryAfterSec !== undefined) {
    response.headers.set('Retry-After', String(decision.headers.retryAfterSec));
  }
  return response;
}

export function buildBlockedBody(decision, mutation) {
  return {
    error: decision.reason || 'Checkout request blocked by abuse controls.',
    code: decision.code || 'CHECKOUT_RATE_LIMIT_EXCEEDED',
    mutation,
    ...(decision.dimension ? { dimension: decision.dimension } : {}),
    ...(decision.headers?.retryAfterSec !== undefined
      ? { retryAfter: decision.headers.retryAfterSec }
      : {}),
    limit: decision.headers?.limit,
    resetAt: decision.headers?.resetAtEpochSec,
    remedy: decision.remedy,
  };
}

export const checkoutAbuseController = new CheckoutAbuseController();

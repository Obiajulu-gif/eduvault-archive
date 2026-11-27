import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Signed download authorization with enforced byte and expiry limits.
 *
 * Provides:
 *  - HMAC-SHA256 signed download tokens with key-id (kid) support for
 *    zero-downtime secret rotation and rollback.
 *  - Strict byte-range and total byte-budget enforcement at both issuance
 *    and redemption/authorization time.
 *  - Strict expiry (TTL) bounds and clock-skew protection.
 *  - Stateful authorization lifecycle covering normal delivery, retryable
 *    partial failures with remaining byte-budget tracking, idempotent retries,
 *    and immediate token revocation.
 */

export const DEFAULT_TTL_MS = 15_000;
export const DEFAULT_MIN_TTL_MS = 1_000;
export const DEFAULT_MAX_TTL_MS = 300_000; // 5 minutes
export const DEFAULT_MAX_BYTES = 10_000_000; // 10 MB
export const DEFAULT_MAX_CLOCK_SKEW_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 3;

export function getDownloadAuthConfig(overrides = {}) {
  const secret =
    overrides.secret ??
    process.env.DOWNLOAD_CAPABILITY_SECRET ??
    process.env.JWT_SECRET ??
    'changeme-in-production';

  const keyId = overrides.keyId ?? process.env.DOWNLOAD_CAPABILITY_KEY_ID ?? 'v1';

  const previousSecrets = overrides.previousSecrets ?? {};
  const defaultTtlMs = Number(
    overrides.defaultTtlMs ?? process.env.CAPABILITY_TTL_MS ?? DEFAULT_TTL_MS
  );
  const minTtlMs = Number(
    overrides.minTtlMs ?? process.env.CAPABILITY_MIN_TTL_MS ?? DEFAULT_MIN_TTL_MS
  );
  const maxTtlMs = Number(
    overrides.maxTtlMs ?? process.env.CAPABILITY_MAX_TTL_MS ?? DEFAULT_MAX_TTL_MS
  );
  const maxBytesLimit = Number(
    overrides.maxBytesLimit ?? process.env.CAPABILITY_MAX_BYTES ?? DEFAULT_MAX_BYTES
  );
  const maxClockSkewMs = Number(
    overrides.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS
  );
  const maxRetries = Number(overrides.maxRetries ?? DEFAULT_MAX_RETRIES);

  return {
    secret,
    keyId,
    previousSecrets,
    defaultTtlMs,
    minTtlMs,
    maxTtlMs,
    maxBytesLimit,
    maxClockSkewMs,
    maxRetries,
  };
}

function signPayload(payloadJson, secret) {
  return createHmac('sha256', secret).update(payloadJson).digest('hex');
}

function timingSafeHexEqual(expectedHex, receivedHex) {
  if (typeof expectedHex !== 'string' || typeof receivedHex !== 'string') {
    return false;
  }
  if (expectedHex.length !== receivedHex.length || expectedHex.length % 2 !== 0) {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  const received = Buffer.from(receivedHex, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Parse and validate an HTTP-style byte range string like "0-1023".
 * Returns `{ ok: true, byteRangeStart, byteRangeEnd, rangeSize }` or
 * `{ ok: false, reason, message }`.
 */
export function parseByteRangeParam(rangeParam) {
  if (rangeParam === undefined || rangeParam === null || rangeParam === '') {
    return { ok: true, byteRangeStart: 0, byteRangeEnd: null, rangeSize: null };
  }
  if (typeof rangeParam !== 'string' || !/^(\d+)-(\d+)$/.test(rangeParam.trim())) {
    return {
      ok: false,
      reason: 'invalid_byte_range_format',
      message: 'Invalid byte range format; expected "<start>-<end>" with non-negative integers',
    };
  }
  const [startStr, endStr] = rangeParam.trim().split('-');
  const byteRangeStart = Number.parseInt(startStr, 10);
  const byteRangeEnd = Number.parseInt(endStr, 10);
  if (!Number.isSafeInteger(byteRangeStart) || !Number.isSafeInteger(byteRangeEnd)) {
    return {
      ok: false,
      reason: 'invalid_byte_range_bounds',
      message: 'Byte range bounds must be safe non-negative integers',
    };
  }
  if (byteRangeEnd < byteRangeStart) {
    return {
      ok: false,
      reason: 'inverted_byte_range',
      message: 'Invalid byte range: end must be >= start',
    };
  }
  return {
    ok: true,
    byteRangeStart,
    byteRangeEnd,
    rangeSize: byteRangeEnd - byteRangeStart + 1,
  };
}

/**
 * Validate byte range and maxBytes against server policy.
 */
export function validateByteLimits(
  { byteRangeStart = 0, byteRangeEnd = null, maxBytes } = {},
  maxBytesLimit = DEFAULT_MAX_BYTES
) {
  if (!Number.isSafeInteger(byteRangeStart) || byteRangeStart < 0) {
    return { ok: false, reason: 'invalid_byte_range_start' };
  }

  let rangeSize = null;
  if (byteRangeEnd !== null && byteRangeEnd !== undefined) {
    if (!Number.isSafeInteger(byteRangeEnd) || byteRangeEnd < 0) {
      return { ok: false, reason: 'invalid_byte_range_end' };
    }
    if (byteRangeEnd < byteRangeStart) {
      return { ok: false, reason: 'inverted_byte_range' };
    }
    rangeSize = byteRangeEnd - byteRangeStart + 1;
  }

  if (maxBytes !== undefined && maxBytes !== null) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      return { ok: false, reason: 'invalid_max_bytes' };
    }
    if (maxBytes > maxBytesLimit) {
      return { ok: false, reason: 'byte_limit_exceeds_max' };
    }
  }

  if (rangeSize !== null && rangeSize > maxBytesLimit) {
    return { ok: false, reason: 'byte_range_exceeds_max' };
  }

  const effectiveMaxBytes =
    maxBytes !== undefined && maxBytes !== null
      ? maxBytes
      : rangeSize !== null
        ? rangeSize
        : maxBytesLimit;

  if (rangeSize !== null && rangeSize > effectiveMaxBytes) {
    return { ok: false, reason: 'byte_range_quota_exceeded' };
  }

  return {
    ok: true,
    byteRangeStart,
    byteRangeEnd: byteRangeEnd ?? null,
    rangeSize,
    maxBytes: effectiveMaxBytes,
  };
}

/**
 * Validate and resolve TTL (expiry duration) within [minTtlMs, maxTtlMs].
 */
export function validateExpiryLimit(ttlMs, config = getDownloadAuthConfig()) {
  const effectiveTtl = ttlMs === undefined || ttlMs === null ? config.defaultTtlMs : Number(ttlMs);
  if (!Number.isFinite(effectiveTtl) || effectiveTtl <= 0) {
    return { ok: false, reason: 'invalid_ttl' };
  }
  if (effectiveTtl < config.minTtlMs) {
    return { ok: false, reason: 'ttl_below_min' };
  }
  if (effectiveTtl > config.maxTtlMs) {
    return { ok: false, reason: 'ttl_exceeds_max' };
  }
  return { ok: true, ttlMs: Math.floor(effectiveTtl) };
}

/**
 * Create a signed download authorization token.
 */
export function createSignedDownloadToken(
  {
    buyer,
    material,
    byteRangeStart = 0,
    byteRangeEnd = null,
    maxBytes,
    ttlMs,
    nonce,
    attempt = 1,
    parentJti = null,
    now = Date.now(),
  },
  configOverrides = {}
) {
  const config = getDownloadAuthConfig(configOverrides);

  if (!buyer || typeof buyer !== 'string') {
    return { ok: false, reason: 'missing_buyer' };
  }
  if (!material || typeof material !== 'string') {
    return { ok: false, reason: 'missing_material' };
  }

  const byteCheck = validateByteLimits(
    { byteRangeStart, byteRangeEnd, maxBytes },
    config.maxBytesLimit
  );
  if (!byteCheck.ok) {
    return byteCheck;
  }

  const ttlCheck = validateExpiryLimit(ttlMs, config);
  if (!ttlCheck.ok) {
    return ttlCheck;
  }

  const payload = {
    v: 1,
    kid: config.keyId,
    buyer,
    material,
    byteRangeStart: byteCheck.byteRangeStart,
    byteRangeEnd: byteCheck.byteRangeEnd,
    maxBytes: byteCheck.maxBytes,
    byteRangeQuota: byteCheck.maxBytes,
    nonce: nonce || randomUUID(),
    attempt,
    parentJti,
    iat: now,
    exp: now + ttlCheck.ttlMs,
    jti: randomUUID(),
  };

  const payloadJson = JSON.stringify(payload);
  const signature = signPayload(payloadJson, config.secret);
  const token = Buffer.from(
    JSON.stringify({ payload: payloadJson, signature, kid: config.keyId })
  ).toString('base64url');

  return {
    ok: true,
    token,
    payload,
    expiresAt: new Date(payload.exp).toISOString(),
    expiresInMs: ttlCheck.ttlMs,
  };
}

/**
 * Cryptographically verify a signed download token, its expiry, identity
 * binding, and requested byte limits.
 */
export function verifySignedDownloadToken(
  token,
  {
    buyerAddress,
    materialId,
    requestedBytes,
    requestedRangeStart,
    requestedRangeEnd,
    now = Date.now(),
  } = {},
  configOverrides = {}
) {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'missing_token' };
  }

  const config = getDownloadAuthConfig(configOverrides);

  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
  } catch {
    return { valid: false, reason: 'malformed_token' };
  }

  if (!envelope || typeof envelope !== 'object') {
    return { valid: false, reason: 'malformed_token' };
  }

  const { payload: payloadJson, signature, kid } = envelope;
  if (typeof payloadJson !== 'string' || typeof signature !== 'string') {
    return { valid: false, reason: 'malformed_token' };
  }

  // Resolve verification secret by key ID to support zero-downtime rotation & rollback.
  let verifySecret = config.secret;
  if (kid !== undefined && kid !== config.keyId) {
    if (Object.prototype.hasOwnProperty.call(config.previousSecrets, kid)) {
      verifySecret = config.previousSecrets[kid];
    } else {
      return { valid: false, reason: 'unknown_key_id' };
    }
  }

  const expectedSig = signPayload(payloadJson, verifySecret);
  if (!timingSafeHexEqual(expectedSig, signature)) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { valid: false, reason: 'malformed_payload' };
  }

  if (buyerAddress !== undefined && payload.buyer !== buyerAddress) {
    return { valid: false, reason: 'buyer_mismatch' };
  }
  if (materialId !== undefined && payload.material !== materialId) {
    return { valid: false, reason: 'material_mismatch' };
  }
  if (!payload.nonce || typeof payload.nonce !== 'string') {
    return { valid: false, reason: 'missing_nonce' };
  }

  // Expiry & clock skew checks
  if (typeof payload.iat !== 'number' || payload.iat > now + config.maxClockSkewMs) {
    return { valid: false, reason: 'future_dated' };
  }
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    return { valid: false, reason: 'expired' };
  }

  // Byte limit checks on token payload itself
  const tokenMaxBytes = payload.maxBytes ?? payload.byteRangeQuota;
  if (typeof tokenMaxBytes !== 'number' || tokenMaxBytes <= 0 || tokenMaxBytes > config.maxBytesLimit) {
    return { valid: false, reason: 'byte_range_exceeds_max' };
  }

  const payloadRangeSize =
    payload.byteRangeEnd !== null && payload.byteRangeEnd !== undefined
      ? payload.byteRangeEnd - payload.byteRangeStart + 1
      : null;

  if (payloadRangeSize !== null) {
    if (payloadRangeSize <= 0) {
      return { valid: false, reason: 'inverted_byte_range' };
    }
    if (payloadRangeSize > tokenMaxBytes) {
      return { valid: false, reason: 'byte_range_quota_exceeded' };
    }
  }

  // Redemption-time requested byte range / size checks
  if (requestedBytes !== undefined && requestedBytes !== null) {
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) {
      return { valid: false, reason: 'invalid_requested_bytes' };
    }
    if (requestedBytes > tokenMaxBytes) {
      return { valid: false, reason: 'requested_bytes_exceed_limit' };
    }
  }

  if (requestedRangeStart !== undefined && requestedRangeEnd !== undefined) {
    if (
      !Number.isSafeInteger(requestedRangeStart) ||
      !Number.isSafeInteger(requestedRangeEnd) ||
      requestedRangeStart < 0 ||
      requestedRangeEnd < requestedRangeStart
    ) {
      return { valid: false, reason: 'invalid_requested_range' };
    }
    if (requestedRangeStart < payload.byteRangeStart) {
      return { valid: false, reason: 'requested_range_out_of_bounds' };
    }
    if (
      payload.byteRangeEnd !== null &&
      payload.byteRangeEnd !== undefined &&
      requestedRangeEnd > payload.byteRangeEnd
    ) {
      return { valid: false, reason: 'requested_range_out_of_bounds' };
    }
    const reqSize = requestedRangeEnd - requestedRangeStart + 1;
    if (reqSize > tokenMaxBytes) {
      return { valid: false, reason: 'requested_bytes_exceed_limit' };
    }
  }

  return { valid: true, payload };
}

/**
 * In-memory state store for download authorizations, supporting idempotency,
 * retry byte-budget accounting, and revocation.
 */
export function createInMemoryDownloadAuthStore() {
  const byJti = new Map();
  const byIdempotencyKey = new Map();

  return {
    getByJti(jti) {
      return byJti.get(jti) ?? null;
    },
    save(record) {
      byJti.set(record.jti, { ...record });
      if (record.idempotencyKey) {
        byIdempotencyKey.set(record.idempotencyKey, record.jti);
      }
    },
    getByIdempotencyKey(key) {
      const jti = byIdempotencyKey.get(key);
      return jti ? byJti.get(jti) ?? null : null;
    },
    update(jti, patch) {
      const current = byJti.get(jti);
      if (!current) return null;
      const updated = { ...current, ...patch };
      byJti.set(jti, updated);
      return updated;
    },
  };
}

/**
 * Stateful service orchestrating issuance, idempotent/bounded retries,
 * redemption authorization, failure recording, and revocation.
 */
export function createDownloadAuthorizationService({
  store = createInMemoryDownloadAuthStore(),
  config = {},
} = {}) {
  const resolvedConfig = getDownloadAuthConfig(config);

  function issue({
    buyer,
    material,
    byteRangeStart = 0,
    byteRangeEnd = null,
    maxBytes,
    ttlMs,
    nonce,
    idempotencyKey = null,
    retryOf = null,
    now = Date.now(),
  }) {
    // 1. Idempotent retry check
    if (idempotencyKey) {
      const existing = store.getByIdempotencyKey(idempotencyKey);
      if (existing) {
        const sameParams =
          existing.buyer === buyer &&
          existing.material === material &&
          existing.byteRangeStart === byteRangeStart &&
          existing.byteRangeEnd === (byteRangeEnd ?? null);
        if (!sameParams) {
          return { ok: false, reason: 'idempotency_conflict' };
        }
        if (existing.status === 'revoked') {
          return { ok: false, reason: 'token_revoked' };
        }
        if (existing.exp >= now && existing.status === 'issued') {
          return {
            ok: true,
            idempotentReplay: true,
            token: existing.token,
            payload: existing.payload,
            expiresAt: new Date(existing.exp).toISOString(),
            expiresInMs: Math.max(0, existing.exp - now),
          };
        }
      }
    }

    // 2. Bounded retry from a previous failed/expired authorization
    let attempt = 1;
    let effectiveMaxBytes = maxBytes;
    if (retryOf) {
      const prev = store.getByJti(retryOf);
      if (!prev) {
        return { ok: false, reason: 'retry_source_not_found' };
      }
      if (prev.buyer !== buyer || prev.material !== material) {
        return { ok: false, reason: 'retry_identity_mismatch' };
      }
      if (prev.status === 'revoked') {
        return { ok: false, reason: 'token_revoked' };
      }
      if (prev.status === 'completed') {
        return { ok: false, reason: 'already_completed' };
      }
      if (prev.attempt >= resolvedConfig.maxRetries) {
        return { ok: false, reason: 'retry_limit_exceeded' };
      }
      const remainingBytes = prev.maxBytes - prev.bytesDelivered;
      if (remainingBytes <= 0) {
        return { ok: false, reason: 'byte_budget_exhausted' };
      }
      attempt = prev.attempt + 1;
      effectiveMaxBytes =
        effectiveMaxBytes !== undefined && effectiveMaxBytes !== null
          ? Math.min(effectiveMaxBytes, remainingBytes)
          : remainingBytes;
    }

    const issued = createSignedDownloadToken(
      {
        buyer,
        material,
        byteRangeStart,
        byteRangeEnd,
        maxBytes: effectiveMaxBytes,
        ttlMs,
        nonce,
        attempt,
        parentJti: retryOf,
        now,
      },
      resolvedConfig
    );

    if (!issued.ok) {
      return issued;
    }

    store.save({
      jti: issued.payload.jti,
      parentJti: retryOf,
      idempotencyKey,
      buyer,
      material,
      byteRangeStart: issued.payload.byteRangeStart,
      byteRangeEnd: issued.payload.byteRangeEnd,
      maxBytes: issued.payload.maxBytes,
      bytesDelivered: 0,
      attempt,
      exp: issued.payload.exp,
      status: 'issued',
      token: issued.token,
      payload: issued.payload,
    });

    return { ...issued, idempotentReplay: false };
  }

  function authorize(
    token,
    {
      buyerAddress,
      materialId,
      requestedBytes,
      requestedRangeStart,
      requestedRangeEnd,
      now = Date.now(),
    } = {}
  ) {
    const verification = verifySignedDownloadToken(
      token,
      {
        buyerAddress,
        materialId,
        requestedBytes,
        requestedRangeStart,
        requestedRangeEnd,
        now,
      },
      resolvedConfig
    );
    if (!verification.valid) {
      return { authorized: false, reason: verification.reason };
    }

    const record = store.getByJti(verification.payload.jti);
    if (record) {
      if (record.status === 'revoked') {
        return { authorized: false, reason: 'token_revoked' };
      }
      if (record.status === 'completed') {
        return { authorized: false, reason: 'already_completed' };
      }
      const bytesToConsume =
        requestedBytes ??
        (requestedRangeStart !== undefined && requestedRangeEnd !== undefined
          ? requestedRangeEnd - requestedRangeStart + 1
          : verification.payload.maxBytes);

      if (record.bytesDelivered + bytesToConsume > record.maxBytes) {
        return { authorized: false, reason: 'byte_budget_exhausted' };
      }
    }

    return {
      authorized: true,
      payload: verification.payload,
      remainingBytes: record ? record.maxBytes - record.bytesDelivered : verification.payload.maxBytes,
    };
  }

  function recordCompletion(jti, bytesDelivered) {
    const record = store.getByJti(jti);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status === 'revoked') return { ok: false, reason: 'token_revoked' };
    const total = record.bytesDelivered + bytesDelivered;
    if (total > record.maxBytes) {
      return { ok: false, reason: 'byte_budget_exhausted' };
    }
    const updated = store.update(jti, {
      bytesDelivered: total,
      status: 'completed',
    });
    return { ok: true, record: updated };
  }

  function recordFailure(jti, { bytesDelivered = 0, errorCode = 'transfer_interrupted' } = {}) {
    const record = store.getByJti(jti);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status === 'revoked') return { ok: false, reason: 'token_revoked' };
    const total = Math.min(record.maxBytes, record.bytesDelivered + Math.max(0, bytesDelivered));
    const updated = store.update(jti, {
      bytesDelivered: total,
      status: 'failed_retryable',
      lastErrorCode: errorCode,
    });
    return {
      ok: true,
      record: updated,
      remainingBytes: updated.maxBytes - updated.bytesDelivered,
      retriesRemaining: Math.max(0, resolvedConfig.maxRetries - updated.attempt),
    };
  }

  function revoke(jti, reason = 'manual_revocation') {
    const record = store.getByJti(jti);
    if (!record) return { ok: false, reason: 'not_found' };
    const updated = store.update(jti, {
      status: 'revoked',
      revocationReason: reason,
    });
    return { ok: true, record: updated };
  }

  return {
    issue,
    authorize,
    recordCompletion,
    recordFailure,
    revoke,
  };
}

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  parseByteRangeParam,
  validateByteLimits,
  validateExpiryLimit,
  createSignedDownloadToken,
  verifySignedDownloadToken,
  createDownloadAuthorizationService,
} from '../../src/lib/downloads/signedDownloadAuth.js';

const TEST_CONFIG = {
  secret: 'primary-secret-v2',
  keyId: 'v2',
  previousSecrets: { v1: 'legacy-secret-v1' },
  defaultTtlMs: 15_000,
  minTtlMs: 1_000,
  maxTtlMs: 60_000,
  maxBytesLimit: 10_000,
  maxClockSkewMs: 5_000,
  maxRetries: 3,
};

describe('signed download authorization with byte and expiry limits', () => {
  describe('byte range & expiry validation', () => {
    it('parses valid byte ranges and rejects malformed or inverted ranges', () => {
      assert.deepEqual(parseByteRangeParam(''), {
        ok: true,
        byteRangeStart: 0,
        byteRangeEnd: null,
        rangeSize: null,
      });
      assert.deepEqual(parseByteRangeParam('0-1023'), {
        ok: true,
        byteRangeStart: 0,
        byteRangeEnd: 1023,
        rangeSize: 1024,
      });
      assert.equal(parseByteRangeParam('abc').ok, false);
      assert.equal(parseByteRangeParam('100-50').reason, 'inverted_byte_range');
      assert.equal(parseByteRangeParam('-5-10').reason, 'invalid_byte_range_format');
    });

    it('enforces maxBytesLimit and byte-range consistency', () => {
      const openEnded = validateByteLimits({ byteRangeStart: 0, byteRangeEnd: null }, 10_000);
      assert.equal(openEnded.ok, true);
      assert.equal(openEnded.maxBytes, 10_000);

      const bounded = validateByteLimits({ byteRangeStart: 0, byteRangeEnd: 999 }, 10_000);
      assert.equal(bounded.ok, true);
      assert.equal(bounded.maxBytes, 1000);

      assert.equal(
        validateByteLimits({ byteRangeStart: 0, byteRangeEnd: 10_000 }, 10_000).reason,
        'byte_range_exceeds_max'
      );
      assert.equal(
        validateByteLimits({ byteRangeStart: 0, byteRangeEnd: 999, maxBytes: 500 }, 10_000).reason,
        'byte_range_quota_exceeded'
      );
      assert.equal(
        validateByteLimits({ byteRangeStart: -1, byteRangeEnd: 10 }, 10_000).reason,
        'invalid_byte_range_start'
      );
    });

    it('enforces min and max expiry limits', () => {
      assert.deepEqual(validateExpiryLimit(undefined, TEST_CONFIG), { ok: true, ttlMs: 15_000 });
      assert.deepEqual(validateExpiryLimit(5_000, TEST_CONFIG), { ok: true, ttlMs: 5_000 });
      assert.equal(validateExpiryLimit(500, TEST_CONFIG).reason, 'ttl_below_min');
      assert.equal(validateExpiryLimit(120_000, TEST_CONFIG).reason, 'ttl_exceeds_max');
      assert.equal(validateExpiryLimit(-1, TEST_CONFIG).reason, 'invalid_ttl');
    });
  });

  describe('normal path', () => {
    it('issues, verifies, authorizes, and completes a bounded signed download', () => {
      const now = 1_700_000_000_000;
      const svc = createDownloadAuthorizationService({ config: TEST_CONFIG });

      const issued = svc.issue({
        buyer: 'GBUYER1',
        material: 'mat-1',
        byteRangeStart: 0,
        byteRangeEnd: 4095,
        ttlMs: 10_000,
        now,
      });

      assert.equal(issued.ok, true);
      assert.equal(issued.payload.maxBytes, 4096);
      assert.equal(issued.payload.exp, now + 10_000);

      const auth = svc.authorize(issued.token, {
        buyerAddress: 'GBUYER1',
        materialId: 'mat-1',
        requestedRangeStart: 0,
        requestedRangeEnd: 4095,
        now: now + 5_000,
      });
      assert.equal(auth.authorized, true);
      assert.equal(auth.remainingBytes, 4096);

      const done = svc.recordCompletion(issued.payload.jti, 4096);
      assert.equal(done.ok, true);
      assert.equal(done.record.status, 'completed');

      // Replay after completion is rejected
      const replay = svc.authorize(issued.token, {
        buyerAddress: 'GBUYER1',
        materialId: 'mat-1',
        requestedBytes: 100,
        now: now + 6_000,
      });
      assert.equal(replay.authorized, false);
      assert.equal(replay.reason, 'already_completed');
    });

    it('always binds a signed maxBytes limit even for open-ended downloads', () => {
      const now = 1_700_000_000_000;
      const issued = createSignedDownloadToken(
        { buyer: 'GBUYER1', material: 'mat-open', maxBytes: 2048, now },
        TEST_CONFIG
      );
      assert.equal(issued.ok, true);
      assert.equal(issued.payload.byteRangeEnd, null);
      assert.equal(issued.payload.maxBytes, 2048);

      assert.equal(
        verifySignedDownloadToken(
          issued.token,
          { buyerAddress: 'GBUYER1', materialId: 'mat-open', requestedBytes: 2048, now },
          TEST_CONFIG
        ).valid,
        true
      );
      assert.equal(
        verifySignedDownloadToken(
          issued.token,
          { buyerAddress: 'GBUYER1', materialId: 'mat-open', requestedBytes: 2049, now },
          TEST_CONFIG
        ).reason,
        'requested_bytes_exceed_limit'
      );
    });
  });

  describe('failure & tampering paths', () => {
    it('rejects tampered payload, malformed token, missing token, and expired token', () => {
      const now = 1_700_000_000_000;
      const issued = createSignedDownloadToken(
        { buyer: 'GBUYER1', material: 'mat-1', byteRangeStart: 0, byteRangeEnd: 1023, ttlMs: 5_000, now },
        TEST_CONFIG
      );

      // Tamper maxBytes in payload without re-signing
      const env = JSON.parse(Buffer.from(issued.token, 'base64url').toString('utf-8'));
      const payload = JSON.parse(env.payload);
      payload.maxBytes = 999_999;
      env.payload = JSON.stringify(payload);
      const tampered = Buffer.from(JSON.stringify(env)).toString('base64url');

      assert.equal(
        verifySignedDownloadToken(tampered, { buyerAddress: 'GBUYER1', materialId: 'mat-1', now }, TEST_CONFIG).reason,
        'signature_mismatch'
      );
      assert.equal(verifySignedDownloadToken('', {}, TEST_CONFIG).reason, 'missing_token');
      assert.equal(verifySignedDownloadToken('not-base64-json', {}, TEST_CONFIG).reason, 'malformed_token');

      // Expired token
      assert.equal(
        verifySignedDownloadToken(
          issued.token,
          { buyerAddress: 'GBUYER1', materialId: 'mat-1', now: now + 5_001 },
          TEST_CONFIG
        ).reason,
        'expired'
      );

      // Future-dated token beyond clock skew
      assert.equal(
        verifySignedDownloadToken(
          issued.token,
          { buyerAddress: 'GBUYER1', materialId: 'mat-1', now: now - 10_000 },
          TEST_CONFIG
        ).reason,
        'future_dated'
      );
    });

    it('rejects redemption when requested range is outside signed range', () => {
      const now = 1_700_000_000_000;
      const issued = createSignedDownloadToken(
        { buyer: 'GBUYER1', material: 'mat-1', byteRangeStart: 100, byteRangeEnd: 500, now },
        TEST_CONFIG
      );

      assert.equal(
        verifySignedDownloadToken(
          issued.token,
          { buyerAddress: 'GBUYER1', materialId: 'mat-1', requestedRangeStart: 50, requestedRangeEnd: 200, now },
          TEST_CONFIG
        ).reason,
        'requested_range_out_of_bounds'
      );
      assert.equal(
        verifySignedDownloadToken(
          issued.token,
          { buyerAddress: 'GBUYER1', materialId: 'mat-1', requestedRangeStart: 100, requestedRangeEnd: 600, now },
          TEST_CONFIG
        ).reason,
        'requested_range_out_of_bounds'
      );
    });
  });

  describe('authorization & key rotation / revocation paths', () => {
    it('enforces buyer and material binding and immediate revocation', () => {
      const now = 1_700_000_000_000;
      const svc = createDownloadAuthorizationService({ config: TEST_CONFIG });
      const issued = svc.issue({ buyer: 'GBUYER1', material: 'mat-1', maxBytes: 1024, now });

      assert.equal(
        svc.authorize(issued.token, { buyerAddress: 'GOTHER', materialId: 'mat-1', now }).reason,
        'buyer_mismatch'
      );
      assert.equal(
        svc.authorize(issued.token, { buyerAddress: 'GBUYER1', materialId: 'mat-2', now }).reason,
        'material_mismatch'
      );

      const revoked = svc.revoke(issued.payload.jti, 'refund_processed');
      assert.equal(revoked.ok, true);

      assert.equal(
        svc.authorize(issued.token, { buyerAddress: 'GBUYER1', materialId: 'mat-1', now }).reason,
        'token_revoked'
      );
    });

    it('verifies tokens signed with previous key during rotation and rejects unknown kid', () => {
      const now = 1_700_000_000_000;
      const legacyToken = createSignedDownloadToken(
        { buyer: 'GBUYER1', material: 'mat-1', maxBytes: 1024, now },
        { ...TEST_CONFIG, secret: 'legacy-secret-v1', keyId: 'v1' }
      );

      const verified = verifySignedDownloadToken(
        legacyToken.token,
        { buyerAddress: 'GBUYER1', materialId: 'mat-1', now },
        TEST_CONFIG
      );
      assert.equal(verified.valid, true);

      // Unknown kid is rejected
      const payloadJson = JSON.stringify({ ...legacyToken.payload, kid: 'v999' });
      const sig = createHmac('sha256', 'primary-secret-v2').update(payloadJson).digest('hex');
      const unknownKidToken = Buffer.from(
        JSON.stringify({ payload: payloadJson, signature: sig, kid: 'v999' })
      ).toString('base64url');
      assert.equal(
        verifySignedDownloadToken(unknownKidToken, { buyerAddress: 'GBUYER1', materialId: 'mat-1', now }, TEST_CONFIG)
          .reason,
        'unknown_key_id'
      );
    });
  });

  describe('retry paths', () => {
    it('returns the same token on idempotent retry and rejects parameter conflicts', () => {
      const now = 1_700_000_000_000;
      const svc = createDownloadAuthorizationService({ config: TEST_CONFIG });

      const first = svc.issue({
        buyer: 'GBUYER1',
        material: 'mat-1',
        byteRangeStart: 0,
        byteRangeEnd: 1023,
        idempotencyKey: 'idem-1',
        now,
      });
      assert.equal(first.ok, true);
      assert.equal(first.idempotentReplay, false);

      const replay = svc.issue({
        buyer: 'GBUYER1',
        material: 'mat-1',
        byteRangeStart: 0,
        byteRangeEnd: 1023,
        idempotencyKey: 'idem-1',
        now: now + 1_000,
      });
      assert.equal(replay.ok, true);
      assert.equal(replay.idempotentReplay, true);
      assert.equal(replay.token, first.token);

      const conflict = svc.issue({
        buyer: 'GBUYER1',
        material: 'mat-2',
        byteRangeStart: 0,
        byteRangeEnd: 1023,
        idempotencyKey: 'idem-1',
        now: now + 1_000,
      });
      assert.equal(conflict.ok, false);
      assert.equal(conflict.reason, 'idempotency_conflict');
    });

    it('allows bounded retry for remaining byte budget after partial failure and caps maxRetries', () => {
      const now = 1_700_000_000_000;
      const svc = createDownloadAuthorizationService({ config: TEST_CONFIG });

      const attempt1 = svc.issue({
        buyer: 'GBUYER1',
        material: 'mat-1',
        maxBytes: 4000,
        now,
      });
      assert.equal(attempt1.ok, true);

      // Network drops after 1500 bytes delivered
      const fail1 = svc.recordFailure(attempt1.payload.jti, {
        bytesDelivered: 1500,
        errorCode: 'gateway_timeout',
      });
      assert.equal(fail1.ok, true);
      assert.equal(fail1.remainingBytes, 2500);
      assert.equal(fail1.retriesRemaining, 2);

      // Retry 2 gets remaining byte budget (2500)
      const attempt2 = svc.issue({
        buyer: 'GBUYER1',
        material: 'mat-1',
        retryOf: attempt1.payload.jti,
        now: now + 20_000,
      });
      assert.equal(attempt2.ok, true);
      assert.equal(attempt2.payload.attempt, 2);
      assert.equal(attempt2.payload.maxBytes, 2500);

      // Cannot exceed remaining byte budget on retry
      const overAuth = svc.authorize(attempt2.token, {
        buyerAddress: 'GBUYER1',
        materialId: 'mat-1',
        requestedBytes: 3000,
        now: now + 21_000,
      });
      assert.equal(overAuth.authorized, false);
      assert.equal(overAuth.reason, 'requested_bytes_exceed_limit');

      // Fail attempt 2 with 500 bytes delivered -> attempt 3 gets 2000 bytes
      svc.recordFailure(attempt2.payload.jti, { bytesDelivered: 500 });
      const attempt3 = svc.issue({
        buyer: 'GBUYER1',
        material: 'mat-1',
        retryOf: attempt2.payload.jti,
        now: now + 40_000,
      });
      assert.equal(attempt3.ok, true);
      assert.equal(attempt3.payload.attempt, 3);
      assert.equal(attempt3.payload.maxBytes, 2000);

      // Attempt 4 exceeds maxRetries (3)
      svc.recordFailure(attempt3.payload.jti, { bytesDelivered: 100 });
      const attempt4 = svc.issue({
        buyer: 'GBUYER1',
        material: 'mat-1',
        retryOf: attempt3.payload.jti,
        now: now + 60_000,
      });
      assert.equal(attempt4.ok, false);
      assert.equal(attempt4.reason, 'retry_limit_exceeded');
    });
  });
});

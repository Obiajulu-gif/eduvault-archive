import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('capabilityToken — signed, expiring download capabilities (#675)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.DOWNLOAD_CAPABILITY_SECRET = 'test-capability-secret';
    process.env.CAPABILITY_TTL_MS = '15000';
    process.env.CAPABILITY_MAX_BYTES = '10000000';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.useRealTimers();
  });

  it('issues a token that verifies successfully for the bound buyer/material', async () => {
    const { generateCapabilityToken, verifyCapabilityToken } = await import('../capabilityToken');
    const { token } = generateCapabilityToken({
      buyer: 'GBUYER',
      material: 'material-1',
      byteRangeStart: 0,
      byteRangeEnd: 1023,
      nonce: 'nonce-1',
    });

    const result = verifyCapabilityToken(token, { buyerAddress: 'GBUYER', materialId: 'material-1' });
    expect(result.valid).toBe(true);
    expect(result.payload.buyer).toBe('GBUYER');
    expect(result.payload.material).toBe('material-1');
    expect(result.payload.nonce).toBe('nonce-1');
  });

  it('rejects a token whose payload has been tampered with (byte range widened)', async () => {
    const { generateCapabilityToken, verifyCapabilityToken } = await import('../capabilityToken');
    const { token } = generateCapabilityToken({
      buyer: 'GBUYER',
      material: 'material-1',
      byteRangeStart: 0,
      byteRangeEnd: 1023,
      nonce: 'nonce-1',
    });

    // Decode, widen the byte range as an attacker would, re-encode without
    // re-signing (the attacker doesn't have the secret).
    const envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
    const payload = JSON.parse(envelope.payload);
    payload.byteRangeEnd = 10_000_000;
    envelope.payload = JSON.stringify(payload);
    const tamperedToken = Buffer.from(JSON.stringify(envelope)).toString('base64url');

    const result = verifyCapabilityToken(tamperedToken, { buyerAddress: 'GBUYER', materialId: 'material-1' });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('rejects a token tampered to claim a different buyer', async () => {
    const { generateCapabilityToken, verifyCapabilityToken } = await import('../capabilityToken');
    const { token } = generateCapabilityToken({
      buyer: 'GBUYER',
      material: 'material-1',
      byteRangeStart: 0,
      byteRangeEnd: null,
      nonce: 'nonce-1',
    });

    const envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
    const payload = JSON.parse(envelope.payload);
    payload.buyer = 'GATTACKER';
    envelope.payload = JSON.stringify(payload);
    const tamperedToken = Buffer.from(JSON.stringify(envelope)).toString('base64url');

    const result = verifyCapabilityToken(tamperedToken, { buyerAddress: 'GATTACKER', materialId: 'material-1' });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('rejects a token for a different buyer than the one requesting', async () => {
    const { generateCapabilityToken, verifyCapabilityToken } = await import('../capabilityToken');
    const { token } = generateCapabilityToken({
      buyer: 'GBUYER',
      material: 'material-1',
      byteRangeStart: 0,
      byteRangeEnd: null,
      nonce: 'nonce-1',
    });

    const result = verifyCapabilityToken(token, { buyerAddress: 'GSOMEONE_ELSE', materialId: 'material-1' });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('buyer_mismatch');
  });

  it('rejects a token for a different material than requested', async () => {
    const { generateCapabilityToken, verifyCapabilityToken } = await import('../capabilityToken');
    const { token } = generateCapabilityToken({
      buyer: 'GBUYER',
      material: 'material-1',
      byteRangeStart: 0,
      byteRangeEnd: null,
      nonce: 'nonce-1',
    });

    const result = verifyCapabilityToken(token, { buyerAddress: 'GBUYER', materialId: 'material-2' });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('material_mismatch');
  });

  it('expires the token after CAPABILITY_TTL_MS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const { generateCapabilityToken, verifyCapabilityToken } = await import('../capabilityToken');
    const { token } = generateCapabilityToken({
      buyer: 'GBUYER',
      material: 'material-1',
      byteRangeStart: 0,
      byteRangeEnd: null,
      nonce: 'nonce-1',
    });

    vi.setSystemTime(new Date('2026-01-01T00:00:14.000Z')); // 14s later — still valid
    expect(verifyCapabilityToken(token, { buyerAddress: 'GBUYER', materialId: 'material-1' }).valid).toBe(true);

    vi.setSystemTime(new Date('2026-01-01T00:00:16.000Z')); // 16s later — expired (15s TTL)
    const expiredResult = verifyCapabilityToken(token, { buyerAddress: 'GBUYER', materialId: 'material-1' });
    expect(expiredResult.valid).toBe(false);
    expect(expiredResult.reason).toBe('expired');
  });

  it('rejects a byte range wider than CAPABILITY_MAX_BYTES', async () => {
    const { generateCapabilityToken, verifyCapabilityToken, CAPABILITY_MAX_BYTES } = await import(
      '../capabilityToken'
    );
    const { token } = generateCapabilityToken({
      buyer: 'GBUYER',
      material: 'material-1',
      byteRangeStart: 0,
      byteRangeEnd: CAPABILITY_MAX_BYTES + 1000,
      nonce: 'nonce-1',
    });

    const result = verifyCapabilityToken(token, { buyerAddress: 'GBUYER', materialId: 'material-1' });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('byte_range_exceeds_max');
  });

  it('rejects a malformed token instead of throwing', async () => {
    const { verifyCapabilityToken } = await import('../capabilityToken');
    expect(verifyCapabilityToken('not-a-valid-token').valid).toBe(false);
    expect(verifyCapabilityToken('not-a-valid-token').reason).toBe('malformed_token');
  });

  it('rejects a missing token', async () => {
    const { verifyCapabilityToken } = await import('../capabilityToken');
    const result = verifyCapabilityToken(null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_token');
  });

  it('rejects a token missing its nonce', async () => {
    const { generateCapabilityToken, verifyCapabilityToken } = await import('../capabilityToken');
    const { token } = generateCapabilityToken({
      buyer: 'GBUYER',
      material: 'material-1',
      byteRangeStart: 0,
      byteRangeEnd: null,
      nonce: 'nonce-1',
    });

    const envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
    const payload = JSON.parse(envelope.payload);
    delete payload.nonce;
    // Re-sign after deleting the nonce so this test isolates the
    // missing-nonce check from the signature check.
    const { createHmac } = await import('node:crypto');
    const newPayloadJson = JSON.stringify(payload);
    const newSignature = createHmac('sha256', 'test-capability-secret').update(newPayloadJson).digest('hex');
    const resignedToken = Buffer.from(JSON.stringify({ payload: newPayloadJson, signature: newSignature })).toString(
      'base64url'
    );

    const result = verifyCapabilityToken(resignedToken, { buyerAddress: 'GBUYER', materialId: 'material-1' });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_nonce');
  });

  it('two tokens for the same request never collide (unique jti/nonce per issuance)', async () => {
    const { generateCapabilityToken } = await import('../capabilityToken');
    const first = generateCapabilityToken({ buyer: 'GBUYER', material: 'material-1', byteRangeStart: 0, byteRangeEnd: null });
    const second = generateCapabilityToken({ buyer: 'GBUYER', material: 'material-1', byteRangeStart: 0, byteRangeEnd: null });

    expect(first.payload.jti).not.toBe(second.payload.jti);
    expect(first.token).not.toBe(second.token);
  });
});

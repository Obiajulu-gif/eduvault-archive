import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SIGNING_BUFFER_MS,
  evaluateClientQuoteFreshness,
  formatStaleQuoteMessage,
  verifyQuoteBeforeSigning,
} from './staleQuoteGuard';
import { STALE_QUOTE_REASONS } from './quoteConstants';

describe('evaluateClientQuoteFreshness', () => {
  const now = new Date('2026-11-24T12:00:00.000Z').getTime();
  const freshQuote = {
    quoteId: 'q-1',
    materialId: 'mat-1',
    buyerAddress: 'GBUYER123',
    price: 10,
    asset: 'XLM',
    expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
  };

  it('passes for a valid unexpired quote matching buyer and price', () => {
    const result = evaluateClientQuoteFreshness({
      quote: freshQuote,
      materialId: 'mat-1',
      buyerAddress: 'gbuyer123',
      expectedPrice: 10,
      now,
    });
    expect(result.fresh).toBe(true);
    expect(result.stale).toBe(false);
  });

  it('flags missing quotes', () => {
    const result = evaluateClientQuoteFreshness({ quote: null, materialId: 'mat-1', buyerAddress: 'gbuyer123', now });
    expect(result.fresh).toBe(false);
    expect(result.reason).toBe(STALE_QUOTE_REASONS.QUOTE_NOT_FOUND);
  });

  it('flags wallet switches before calling server', () => {
    const result = evaluateClientQuoteFreshness({
      quote: freshQuote,
      materialId: 'mat-1',
      buyerAddress: 'GOTHERWALLET',
      now,
    });
    expect(result.fresh).toBe(false);
    expect(result.reason).toBe(STALE_QUOTE_REASONS.BUYER_MISMATCH);
  });

  it('flags expired quotes and quotes inside the signing safety buffer', () => {
    const expired = evaluateClientQuoteFreshness({
      quote: { ...freshQuote, expiresAt: new Date(now - 1000).toISOString() },
      materialId: 'mat-1',
      buyerAddress: 'GBUYER123',
      now,
    });
    expect(expired.reason).toBe(STALE_QUOTE_REASONS.QUOTE_EXPIRED);

    const expiringSoon = evaluateClientQuoteFreshness({
      quote: { ...freshQuote, expiresAt: new Date(now + DEFAULT_SIGNING_BUFFER_MS - 1000).toISOString() },
      materialId: 'mat-1',
      buyerAddress: 'GBUYER123',
      now,
    });
    expect(expiringSoon.reason).toBe(STALE_QUOTE_REASONS.QUOTE_EXPIRING_SOON);
  });

  it('flags local listing price drift', () => {
    const result = evaluateClientQuoteFreshness({
      quote: freshQuote,
      materialId: 'mat-1',
      buyerAddress: 'GBUYER123',
      expectedPrice: 15,
      now,
    });
    expect(result.fresh).toBe(false);
    expect(result.reason).toBe(STALE_QUOTE_REASONS.TERMS_CHANGED);
    expect(result.changedFields).toEqual(['price']);
  });
});

describe('verifyQuoteBeforeSigning', () => {
  const now = new Date('2026-11-24T12:00:00.000Z').getTime();
  const baseQuote = {
    quoteId: 'q-1',
    materialId: 'mat-1',
    buyerAddress: 'GBUYER123',
    price: 10,
    asset: 'XLM',
    expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
  };

  it('returns ok on the normal path when server confirms freshness', async () => {
    const validateQuoteFn = vi.fn().mockResolvedValue({
      fresh: true,
      stale: false,
      quoteId: 'q-1',
      price: 10,
      asset: 'XLM',
    });

    const result = await verifyQuoteBeforeSigning({
      quote: baseQuote,
      materialId: 'mat-1',
      buyerAddress: 'GBUYER123',
      expectedPrice: 10,
      validateQuoteFn,
      now,
    });

    expect(result.ok).toBe(true);
    expect(validateQuoteFn).toHaveBeenCalledWith({
      materialId: 'mat-1',
      quoteId: 'q-1',
      buyerAddress: 'GBUYER123',
      minRemainingMs: DEFAULT_SIGNING_BUFFER_MS,
    });
  });

  it('short-circuits locally without network call when quote is already expired', async () => {
    const validateQuoteFn = vi.fn();
    const result = await verifyQuoteBeforeSigning({
      quote: { ...baseQuote, expiresAt: new Date(now - 5000).toISOString() },
      materialId: 'mat-1',
      buyerAddress: 'GBUYER123',
      validateQuoteFn,
      now,
    });

    expect(result.ok).toBe(false);
    expect(result.kind).toBe('stale');
    expect(result.source).toBe('client');
    expect(result.canRefresh).toBe(true);
    expect(validateQuoteFn).not.toHaveBeenCalled();
  });

  it('classifies server 409 terms drift with old/new price copy', async () => {
    const err = Object.assign(new Error('Listing terms changed'), {
      status: 409,
      data: {
        code: 'CONFLICT_STATE',
        stale: true,
        reason: STALE_QUOTE_REASONS.TERMS_CHANGED,
        canRefresh: true,
        changedFields: ['price'],
        quoteTerms: { price: 10, asset: 'XLM' },
        currentTerms: { price: 14, asset: 'XLM' },
      },
    });
    const validateQuoteFn = vi.fn().mockRejectedValue(err);

    const result = await verifyQuoteBeforeSigning({
      quote: baseQuote,
      materialId: 'mat-1',
      buyerAddress: 'GBUYER123',
      validateQuoteFn,
      now,
    });

    expect(result.ok).toBe(false);
    expect(result.kind).toBe('stale');
    expect(result.reason).toBe(STALE_QUOTE_REASONS.TERMS_CHANGED);
    expect(result.canRefresh).toBe(true);
    expect(result.message).toMatch(/10\.00 XLM to 14\.00 XLM/);
  });

  it('classifies 401 and 403 as authorization failures', async () => {
    const unauth = Object.assign(new Error('Unauthorized'), {
      status: 401,
      data: { code: 'AUTH_UNAUTHENTICATED', error: 'Unauthorized' },
    });
    const res401 = await verifyQuoteBeforeSigning({
      quote: baseQuote,
      materialId: 'mat-1',
      buyerAddress: 'GBUYER123',
      validateQuoteFn: vi.fn().mockRejectedValue(unauth),
      now,
    });
    expect(res401.ok).toBe(false);
    expect(res401.kind).toBe('auth');
    expect(res401.status).toBe(401);

    const mismatch = Object.assign(new Error('Wallet mismatch'), {
      status: 403,
      data: { code: 'AUTH_WALLET_MISMATCH', error: 'Wallet mismatch' },
    });
    const res403 = await verifyQuoteBeforeSigning({
      quote: baseQuote,
      materialId: 'mat-1',
      buyerAddress: 'GBUYER123',
      validateQuoteFn: vi.fn().mockRejectedValue(mismatch),
      now,
    });
    expect(res403.ok).toBe(false);
    expect(res403.kind).toBe('auth');
    expect(res403.status).toBe(403);
  });

  it('classifies network/5xx errors as retryable validation failures', async () => {
    const networkErr = new Error('Network request failed');
    const result = await verifyQuoteBeforeSigning({
      quote: baseQuote,
      materialId: 'mat-1',
      buyerAddress: 'GBUYER123',
      validateQuoteFn: vi.fn().mockRejectedValue(networkErr),
      now,
    });

    expect(result.ok).toBe(false);
    expect(result.kind).toBe('error');
    expect(result.retryable).toBe(true);
  });

  it('formats non-refreshable archived material message cleanly', () => {
    const msg = formatStaleQuoteMessage({ reason: STALE_QUOTE_REASONS.MATERIAL_ARCHIVED });
    expect(msg.canRefresh).toBe(false);
    expect(msg.title).toMatch(/archived/i);
  });
});

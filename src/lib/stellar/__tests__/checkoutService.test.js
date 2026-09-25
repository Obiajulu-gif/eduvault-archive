import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/stellar/horizonClient', () => ({
  fetchFeeStats: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { fetchFeeStats } from '@/lib/stellar/horizonClient';
import {
  detectSurgePricing,
  calculateDynamicFee,
  verifyWalletAddressMatch,
} from '../checkoutService';

describe('detectSurgePricing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns surging=false when p95 is below threshold', async () => {
    fetchFeeStats.mockResolvedValue({ fee_charged: { p95: '100', p99: '120' } });
    const result = await detectSurgePricing();
    expect(result.surging).toBe(false);
    expect(result.p95Fee).toBe(100);
  });

  it('returns surging=true when p95 exceeds threshold', async () => {
    fetchFeeStats.mockResolvedValue({ fee_charged: { p95: '600', p99: '800' } });
    const result = await detectSurgePricing();
    expect(result.surging).toBe(true);
    expect(result.p95Fee).toBe(600);
  });

  it('defaults surging=false when fetchFeeStats throws', async () => {
    fetchFeeStats.mockRejectedValue(new Error('network error'));
    const result = await detectSurgePricing();
    expect(result.surging).toBe(false);
    expect(result.p95Fee).toBe(100);
  });
});

describe('calculateDynamicFee', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns base fee when not surging', async () => {
    fetchFeeStats.mockResolvedValue({ fee_charged: { p95: '100', p99: '150' } });
    const { feeStroops, surging } = await calculateDynamicFee();
    expect(surging).toBe(false);
    expect(feeStroops).toBe(100);
  });

  it('applies surge multiplier when congested', async () => {
    fetchFeeStats.mockResolvedValue({ fee_charged: { p95: '600', p99: '700' } });
    const { feeStroops, surging } = await calculateDynamicFee();
    expect(surging).toBe(true);
    expect(feeStroops).toBeGreaterThan(100);
  });

  it('caps fee at MAX_FEE_STROOPS', async () => {
    fetchFeeStats.mockResolvedValue({ fee_charged: { p95: '99999', p99: '99999' } });
    const { feeStroops } = await calculateDynamicFee();
    expect(feeStroops).toBeLessThanOrEqual(10000);
  });
});

describe('verifyWalletAddressMatch', () => {
  it('returns valid=true when addresses match (case-insensitive)', () => {
    const result = verifyWalletAddressMatch({
      sessionAddress: 'GADDRESS123ABC',
      payloadAddress: 'gaddress123abc',
    });
    expect(result.valid).toBe(true);
  });

  it('returns valid=false and reason=address_mismatch when addresses differ', () => {
    const result = verifyWalletAddressMatch({
      sessionAddress: 'GADDRESS_SESSION',
      payloadAddress: 'GADDRESS_PAYLOAD',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('address_mismatch');
  });

  it('increments warning counter on each mismatch', () => {
    const sessionState = {};
    verifyWalletAddressMatch({ sessionAddress: 'GA', payloadAddress: 'GB', sessionState });
    verifyWalletAddressMatch({ sessionAddress: 'GA', payloadAddress: 'GB', sessionState });
    expect(sessionState.addressMismatchWarnings).toBe(2);
  });

  it('sets clearSession=true after MAX warnings', () => {
    const sessionState = { addressMismatchWarnings: 1 };
    const result = verifyWalletAddressMatch({
      sessionAddress: 'GA',
      payloadAddress: 'GB',
      sessionState,
    });
    expect(result.clearSession).toBe(true);
  });

  it('returns valid=false with missing_address when inputs are empty', () => {
    const result = verifyWalletAddressMatch({ sessionAddress: '', payloadAddress: 'GA' });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_address');
  });

  it('resets warning counter on successful match', () => {
    const sessionState = { addressMismatchWarnings: 1 };
    verifyWalletAddressMatch({ sessionAddress: 'GADDR', payloadAddress: 'GADDR', sessionState });
    expect(sessionState.addressMismatchWarnings).toBe(0);
  });
});

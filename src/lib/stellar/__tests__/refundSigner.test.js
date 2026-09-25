import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFromSecret, mockSign, mockPublicKey } = vi.hoisted(() => ({
  mockFromSecret: vi.fn(),
  mockSign: vi.fn(),
  mockPublicKey: vi.fn(() => 'GSIGNERPUBLICKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'),
}));

vi.mock('@stellar/stellar-sdk', () => ({
  Keypair: {
    fromSecret: mockFromSecret,
  },
}));

describe('refundSigner — custody boundary for refund payments (Issue #27)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    mockFromSecret.mockReset();
    mockFromSecret.mockReturnValue({ publicKey: mockPublicKey });
    process.env.STELLAR_ADMIN_SECRET = 'S'.padEnd(56, 'A');
    delete process.env.REFUND_SIGNING_DISABLED;
    delete process.env.REFUND_MAX_AMOUNT_PER_TX;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('is enabled by default and disabled only when REFUND_SIGNING_DISABLED=true', async () => {
    const { isRefundSigningEnabled } = await import('../refundSigner');
    expect(isRefundSigningEnabled()).toBe(true);

    process.env.REFUND_SIGNING_DISABLED = 'true';
    expect(isRefundSigningEnabled()).toBe(false);
  });

  it('has no cap by default, and enforces REFUND_MAX_AMOUNT_PER_TX when set', async () => {
    const { getRefundSignerMaxAmount, assertWithinSignerLimit } = await import('../refundSigner');
    expect(getRefundSignerMaxAmount()).toBe(Infinity);
    expect(() => assertWithinSignerLimit(1_000_000)).not.toThrow();

    process.env.REFUND_MAX_AMOUNT_PER_TX = '500';
    expect(getRefundSignerMaxAmount()).toBe(500);
    expect(() => assertWithinSignerLimit(500)).not.toThrow();
    expect(() => assertWithinSignerLimit(500.01)).toThrow(/exceeds signer per-transaction cap/);
  });

  it('rejects an invalid (non-positive/non-finite) amount', async () => {
    const { assertWithinSignerLimit } = await import('../refundSigner');
    expect(() => assertWithinSignerLimit(0)).toThrow(/Invalid refund amount/);
    expect(() => assertWithinSignerLimit(-5)).toThrow(/Invalid refund amount/);
    expect(() => assertWithinSignerLimit(NaN)).toThrow(/Invalid refund amount/);
  });

  it('signRefundTransaction refuses to sign when the emergency kill switch is set', async () => {
    process.env.REFUND_SIGNING_DISABLED = 'true';
    const { signRefundTransaction } = await import('../refundSigner');
    const tx = { sign: vi.fn() };

    expect(() => signRefundTransaction(tx, 10)).toThrow(/Refund signing is disabled/);
    expect(tx.sign).not.toHaveBeenCalled();
  });

  it('signRefundTransaction refuses to sign when the amount exceeds the signer cap', async () => {
    process.env.REFUND_MAX_AMOUNT_PER_TX = '100';
    const { signRefundTransaction } = await import('../refundSigner');
    const tx = { sign: vi.fn() };

    expect(() => signRefundTransaction(tx, 101)).toThrow(/exceeds signer per-transaction cap/);
    expect(tx.sign).not.toHaveBeenCalled();
  });

  it('signRefundTransaction signs with the loaded keypair when enabled and within cap', async () => {
    process.env.REFUND_MAX_AMOUNT_PER_TX = '100';
    const { signRefundTransaction } = await import('../refundSigner');
    const tx = { sign: vi.fn() };

    signRefundTransaction(tx, 100);
    expect(tx.sign).toHaveBeenCalledTimes(1);
  });

  it('getRefundSignerPublicKey throws a clear error when STELLAR_ADMIN_SECRET is missing', async () => {
    delete process.env.STELLAR_ADMIN_SECRET;
    const { getRefundSignerPublicKey } = await import('../refundSigner');
    expect(() => getRefundSignerPublicKey()).toThrow(/Missing STELLAR_ADMIN_SECRET/);
  });
});

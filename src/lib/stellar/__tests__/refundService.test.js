/**
 * Tests for the low-level refund execution layer (Issue #27) — specifically
 * the submission-outcome classification that the refund workflow's
 * crash-safety depends on: a definitive on-chain rejection (safe to rebuild)
 * must never be treated the same as an ambiguous timeout (must reconcile by
 * hash, never resubmit).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSubmitTransaction, mockLoadAccount, mockSignRefundTransaction, mockGetSignerPublicKey } = vi.hoisted(() => ({
  mockSubmitTransaction: vi.fn(),
  mockLoadAccount: vi.fn(),
  mockSignRefundTransaction: vi.fn(),
  mockGetSignerPublicKey: vi.fn(() => 'GSIGNERPUBLICKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'),
}));

vi.mock('../horizonClient', () => ({
  loadAccount: mockLoadAccount,
  submitTransaction: mockSubmitTransaction,
  resolveAssetIssuer: () => 'GISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
}));

vi.mock('../checkoutService', () => ({
  calculateDynamicFee: async () => ({ feeStroops: 100 }),
}));

vi.mock('../refundSigner', () => ({
  signRefundTransaction: mockSignRefundTransaction,
  getRefundSignerPublicKey: mockGetSignerPublicKey,
}));

describe('refundService — treasury balance', () => {
  beforeEach(() => {
    mockLoadAccount.mockReset();
  });

  it('reads the native XLM balance', async () => {
    mockLoadAccount.mockResolvedValue({ balances: [{ asset_type: 'native', balance: '42.5' }] });
    const { getTreasuryBalance } = await import('../refundService');
    expect(await getTreasuryBalance('XLM')).toBe(42.5);
  }, 20000);

  it('reads a non-native asset balance by code', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [
        { asset_type: 'native', balance: '10' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', balance: '250.75' },
      ],
    });
    const { getTreasuryBalance } = await import('../refundService');
    expect(await getTreasuryBalance('USDC')).toBe(250.75);
  });

  it('returns 0 when the signer holds no balance in the asset', async () => {
    mockLoadAccount.mockResolvedValue({ balances: [{ asset_type: 'native', balance: '10' }] });
    const { getTreasuryBalance } = await import('../refundService');
    expect(await getTreasuryBalance('USDC')).toBe(0);
  });
});

describe('refundService — submission outcome classification', () => {
  beforeEach(() => {
    mockSubmitTransaction.mockReset();
    mockSignRefundTransaction.mockReset();
  });

  it('classifies a successful submission as confirmed', async () => {
    mockSignRefundTransaction.mockImplementation(() => {});
    mockSubmitTransaction.mockResolvedValue({ hash: 'abc123', ledger: 555 });
    const { submitRefundTransaction } = await import('../refundService');

    const result = await submitRefundTransaction({}, 10);
    expect(result).toEqual({ outcome: 'confirmed', hash: 'abc123', ledger: 555 });
  });

  it('classifies a bad-sequence rejection as retryable (safe to rebuild)', async () => {
    mockSignRefundTransaction.mockImplementation(() => {});
    mockSubmitTransaction.mockRejectedValue({
      response: { data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } },
      message: 'Bad sequence',
    });
    const { submitRefundTransaction } = await import('../refundService');

    const result = await submitRefundTransaction({}, 10);
    expect(result).toEqual({ outcome: 'rejected', retryable: true, reason: 'tx_bad_seq' });
  });

  it('classifies a timeout/network error as ambiguous (must reconcile by hash, never resubmit)', async () => {
    mockSignRefundTransaction.mockImplementation(() => {});
    mockSubmitTransaction.mockRejectedValue(new Error('Horizon request timed out (8000ms)'));
    const { submitRefundTransaction } = await import('../refundService');

    const result = await submitRefundTransaction({}, 10);
    expect(result.outcome).toBe('ambiguous');
    expect(result.retryable).toBe(false);
  });

  it('never reaches the network when the signer refuses to sign (disabled/over cap)', async () => {
    mockSignRefundTransaction.mockImplementation(() => {
      throw new Error('Refund signing is disabled (REFUND_SIGNING_DISABLED=true)');
    });
    const { submitRefundTransaction } = await import('../refundService');

    const result = await submitRefundTransaction({}, 10);
    expect(result).toEqual({ outcome: 'blocked', retryable: false, reason: 'Refund signing is disabled (REFUND_SIGNING_DISABLED=true)' });
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/config/chain', () => ({
  HORIZON_URL: 'https://horizon-testnet.stellar.org',
  isMainnet: false,
}));

vi.mock('@/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// Patch Horizon.Server before importing the module under test.
const mockSubmit = vi.fn();
const mockLoadAccount = vi.fn();
const mockFeeStats = vi.fn();

vi.mock('@stellar/stellar-sdk', () => ({
  Horizon: {
    Server: vi.fn().mockImplementation(function () {
      this.submitTransaction = mockSubmit;
      this.loadAccount = mockLoadAccount;
      this.feeStats = mockFeeStats;
    }),
  },
}));

import { withFailover, loadAccount, submitTransaction, fetchFeeStats, getConfiguredEndpoints, checkBuyerTrustline } from '../horizonClient';

beforeEach(() => vi.clearAllMocks());

describe('getConfiguredEndpoints', () => {
  it('returns at least the primary URL', () => {
    const endpoints = getConfiguredEndpoints();
    expect(Array.isArray(endpoints)).toBe(true);
    expect(endpoints.length).toBeGreaterThan(0);
  });
});

describe('withFailover', () => {
  it('returns result on first success', async () => {
    mockLoadAccount.mockResolvedValue({ id: 'G123', sequence: '1' });
    const result = await withFailover((server) => server.loadAccount('G123'));
    expect(result.id).toBe('G123');
  });

  it('retries on transient network error and succeeds', async () => {
    mockLoadAccount
      .mockRejectedValueOnce(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))
      .mockResolvedValue({ id: 'G123', sequence: '2' });

    const result = await withFailover((server) => server.loadAccount('G123'), { retries: 2 });
    expect(result.id).toBe('G123');
  });

  it('throws after all retries are exhausted', async () => {
    mockLoadAccount.mockRejectedValue(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    );
    await expect(
      withFailover((server) => server.loadAccount('G123'), { retries: 1 })
    ).rejects.toThrow(/All Horizon endpoints failed after/);
  });

  it('does not retry on non-transient errors (e.g. 404)', async () => {
    mockLoadAccount.mockRejectedValue(
      Object.assign(new Error('Not found'), { response: { status: 404 } })
    );
    await expect(withFailover((server) => server.loadAccount('GNONE'))).rejects.toThrow('Not found');
    // loadAccount called only once — no retry for 404
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
  });
});

describe('loadAccount / submitTransaction / fetchFeeStats wrappers', () => {
  it('loadAccount calls server.loadAccount', async () => {
    mockLoadAccount.mockResolvedValue({ id: 'GABC' });
    const account = await loadAccount('GABC');
    expect(account.id).toBe('GABC');
  });

  it('submitTransaction calls server.submitTransaction', async () => {
    mockSubmit.mockResolvedValue({ hash: 'abc123' });
    const result = await submitTransaction({ toEnvelope: () => ({}) });
    expect(result.hash).toBe('abc123');
  });

  it('fetchFeeStats calls server.feeStats', async () => {
    mockFeeStats.mockResolvedValue({ fee_charged: { p95: '200' } });
    const stats = await fetchFeeStats();
    expect(stats.fee_charged.p95).toBe('200');
  });
});

describe('checkBuyerTrustline', () => {
  const KNOWN_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWRZDPOVPOFWLYERWFBN4JSE3OUQTISLV5EX';

  beforeEach(() => vi.clearAllMocks());

  it('returns hasTrustline=true when account holds the asset', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [
        { asset_type: 'native', balance: '100.00' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: KNOWN_ISSUER, balance: '50.00' },
      ],
    });

    const result = await checkBuyerTrustline('GABC123', 'USDC');
    expect(result.hasTrustline).toBe(true);
    expect(result.balance).toBe('50.00');
    expect(result.issuer).toBe(KNOWN_ISSUER);
  });

  it('returns hasTrustline=false with instructions when asset is missing', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [
        { asset_type: 'native', balance: '100.00' },
      ],
    });

    const result = await checkBuyerTrustline('GABC123', 'USDC');
    expect(result.hasTrustline).toBe(false);
    expect(result.instructions).toBeDefined();
    expect(result.instructions.message).toContain('trustline');
    expect(result.instructions.steps).toBeInstanceOf(Array);
    expect(result.instructions.steps.length).toBeGreaterThan(0);
  });

  it('uses explicit issuer when provided', async () => {
    const customIssuer = 'GCUSTOM123';
    mockLoadAccount.mockResolvedValue({
      balances: [
        { asset_type: 'native', balance: '100.00' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: KNOWN_ISSUER, balance: '50.00' },
      ],
    });

    const result = await checkBuyerTrustline('GABC123', 'USDC', customIssuer);
    expect(result.hasTrustline).toBe(false);
    expect(result.issuer).toBe(customIssuer);
  });

  it('does not match trustlines with wrong asset code', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [
        { asset_type: 'credit_alphanum4', asset_code: 'EURC', asset_issuer: KNOWN_ISSUER, balance: '30.00' },
      ],
    });

    const result = await checkBuyerTrustline('GABC123', 'USDC');
    expect(result.hasTrustline).toBe(false);
  });

  it('does not match native balance as trustline', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [
        { asset_type: 'native', balance: '1000.00' },
      ],
    });

    const result = await checkBuyerTrustline('GABC123', 'XLM');
    expect(result.hasTrustline).toBe(false);
  });
});

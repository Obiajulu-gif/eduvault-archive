import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchBalances, findAssetBalance, BalancesStatus } from '../balance';

const { mockLoadAccount } = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
}));

vi.mock('../kit', () => ({
  horizon: {
    loadAccount: mockLoadAccount,
  },
}));

describe('fetchBalances', () => {
  beforeEach(() => {
    mockLoadAccount.mockReset();
  });

  it('returns loaded status with native and credit assets for a funded account', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [
        { asset_type: 'native', balance: '100.5' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUER123', balance: '50.25' },
      ],
    });

    const result = await fetchBalances('GADDRESS123');

    expect(result.status).toBe('loaded');
    expect(result.snapshot.native).toEqual({ assetType: 'native', balance: '100.5' });
    expect(result.snapshot.balances).toHaveLength(2);
    expect(result.snapshot.balances[0]).toEqual({
      assetType: 'native',
      balance: '100.5',
      assetCode: undefined,
      assetIssuer: undefined,
      liquidityPoolId: undefined,
    });
    expect(result.snapshot.balances[1]).toEqual({
      assetType: 'credit_alphanum4',
      asset_code: 'USDC',
      assetCode: 'USDC',
      asset_issuer: 'GISSUER123',
      assetIssuer: 'GISSUER123',
      balance: '50.25',
      liquidityPoolId: undefined,
    });
  });

  it('includes liquidity pool shares in the balances array without throwing', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [
        { asset_type: 'native', balance: '100' },
        { asset_type: 'liquidity_pool_shares', liquidity_pool_id: 'LP12345', balance: '25.5' },
        { asset_type: 'credit_alphanum12', asset_code: 'TESTCODE', asset_issuer: 'GISSUER456', balance: '10' },
      ],
    });

    const result = await fetchBalances('GADDRESS123');

    expect(result.status).toBe('loaded');
    expect(result.snapshot.balances).toHaveLength(3);
    
    // Verify liquidity pool share is preserved in balances
    const lpShare = result.snapshot.balances.find((b) => b.assetType === 'liquidity_pool_shares');
    expect(lpShare).toEqual({
      assetType: 'liquidity_pool_shares',
      balance: '25.5',
      assetCode: undefined,
      assetIssuer: undefined,
      liquidityPoolId: 'LP12345',
    });
  });

  it('returns unfunded status when account does not exist (404)', async () => {
    const error = new Error('Not found');
    error.response = { status: 404 };
    mockLoadAccount.mockRejectedValue(error);

    const result = await fetchBalances('GUNFUNDED123');

    expect(result.status).toBe('unfunded');
    expect(result.snapshot).toBeUndefined();
  });

  it('returns unfunded status when NotFoundError is thrown (SDK version compatibility)', async () => {
    const error = new Error('Account does not exist');
    error.name = 'NotFoundError';
    error.status = 404;
    mockLoadAccount.mockRejectedValue(error);

    const result = await fetchBalances('GUNFUNDED456');

    expect(result.status).toBe('unfunded');
  });

  it('re-throws network errors (not swallowing as unfunded)', async () => {
    const networkError = new Error('Connection timeout');
    networkError.response = { status: 500 };
    mockLoadAccount.mockRejectedValue(networkError);

    await expect(fetchBalances('GADDRESS123')).rejects.toThrow('Connection timeout');
  });

  it('re-throws other Horizon errors (not swallowing as unfunded)', async () => {
    const horizonError = new Error('Bad request');
    horizonError.response = { status: 400 };
    mockLoadAccount.mockRejectedValue(horizonError);

    await expect(fetchBalances('GADDRESS123')).rejects.toThrow('Bad request');
  });

  it('handles account with zero non-native balances', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '0' }],
    });

    const result = await fetchBalances('GZERO123');

    expect(result.status).toBe('loaded');
    expect(result.snapshot.balances).toHaveLength(1);
    expect(result.snapshot.native).toEqual({ assetType: 'native', balance: '0' });
  });

  it('defaults native balance to 0 if not present in account.balances', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [{ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUER', balance: '10' }],
    });

    const result = await fetchBalances('GADDRESS123');

    expect(result.snapshot.native).toEqual({ assetType: 'native', balance: '0' });
  });

  it('handles both credit_alphanum4 and credit_alphanum12 assets', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [
        { asset_type: 'native', balance: '50' },
        { asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: 'GISSUER1', balance: '100' },
        { asset_type: 'credit_alphanum12', asset_code: 'LONGASSET', asset_issuer: 'GISSUER2', balance: '200' },
      ],
    });

    const result = await fetchBalances('GADDRESS123');

    expect(result.snapshot.balances).toHaveLength(3);
    expect(result.snapshot.balances[1].assetType).toBe('credit_alphanum4');
    expect(result.snapshot.balances[2].assetType).toBe('credit_alphanum12');
  });
});

describe('findAssetBalance', () => {
  it('returns the balance for a matching credit_alphanum4 asset', () => {
    const balances = [
      { assetType: 'native', balance: '100' },
      { assetType: 'credit_alphanum4', assetCode: 'USDC', assetIssuer: 'GISSUER123', balance: '50.5' },
    ];

    const balance = findAssetBalance(balances, 'USDC', 'GISSUER123');

    expect(balance).toBe('50.5');
  });

  it('returns the balance for a matching credit_alphanum12 asset', () => {
    const balances = [
      { assetType: 'credit_alphanum12', assetCode: 'LONGASSET', assetIssuer: 'GISSUER456', balance: '25.75' },
    ];

    const balance = findAssetBalance(balances, 'LONGASSET', 'GISSUER456');

    expect(balance).toBe('25.75');
  });

  it('returns 0 when the asset is not in the balances array', () => {
    const balances = [
      { assetType: 'native', balance: '100' },
      { assetType: 'credit_alphanum4', assetCode: 'USDC', assetIssuer: 'GISSUER123', balance: '50' },
    ];

    const balance = findAssetBalance(balances, 'EUR', 'GISSUER999');

    expect(balance).toBe('0');
  });

  it('correctly skips liquidity pool shares (no assetCode/assetIssuer)', () => {
    const balances = [
      { assetType: 'liquidity_pool_shares', liquidityPoolId: 'LP12345', balance: '100' },
      { assetType: 'credit_alphanum4', assetCode: 'USDC', assetIssuer: 'GISSUER123', balance: '50' },
    ];

    const balance = findAssetBalance(balances, 'USDC', 'GISSUER123');

    expect(balance).toBe('50');
  });

  it('does not throw when encountering a liquidity pool entry', () => {
    const balances = [
      { assetType: 'liquidity_pool_shares', liquidityPoolId: 'LP12345', balance: '100' },
    ];

    expect(() => findAssetBalance(balances, 'USDC', 'GISSUER')).not.toThrow();
  });

  it('distinguishes assets by both assetCode AND assetIssuer', () => {
    const balances = [
      { assetType: 'credit_alphanum4', assetCode: 'USDC', assetIssuer: 'GISSUER_A', balance: '50' },
      { assetType: 'credit_alphanum4', assetCode: 'USDC', assetIssuer: 'GISSUER_B', balance: '100' },
    ];

    const balance1 = findAssetBalance(balances, 'USDC', 'GISSUER_A');
    const balance2 = findAssetBalance(balances, 'USDC', 'GISSUER_B');

    expect(balance1).toBe('50');
    expect(balance2).toBe('100');
  });

  it('returns 0 when assetCode matches but assetIssuer does not', () => {
    const balances = [
      { assetType: 'credit_alphanum4', assetCode: 'USDC', assetIssuer: 'GISSUER123', balance: '50' },
    ];

    const balance = findAssetBalance(balances, 'USDC', 'GISSUER999');

    expect(balance).toBe('0');
  });

  it('handles empty balances array', () => {
    const balance = findAssetBalance([], 'USDC', 'GISSUER');

    expect(balance).toBe('0');
  });

  it('requires exact assetCode match (case-sensitive)', () => {
    const balances = [
      { assetType: 'credit_alphanum4', assetCode: 'usdc', assetIssuer: 'GISSUER', balance: '50' },
    ];

    const balance = findAssetBalance(balances, 'USDC', 'GISSUER');

    expect(balance).toBe('0');
  });

  it('skips native assets when searching for a specific credit asset', () => {
    const balances = [
      { assetType: 'native', balance: '1000', assetCode: undefined, assetIssuer: undefined },
    ];

    const balance = findAssetBalance(balances, 'USDC', 'GISSUER');

    expect(balance).toBe('0');
  });
});

describe('BalancesStatus enum', () => {
  it('has all expected status values', () => {
    expect(BalancesStatus.Idle).toBe('idle');
    expect(BalancesStatus.Loading).toBe('loading');
    expect(BalancesStatus.Loaded).toBe('loaded');
    expect(BalancesStatus.Unfunded).toBe('unfunded');
    expect(BalancesStatus.Error).toBe('error');
  });

  it('Loaded status is produced by fetchBalances on successful account load', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '100' }],
    });

    const result = await fetchBalances('GADDRESS123');

    expect(result.status).toBe(BalancesStatus.Loaded);
  });

  it('Unfunded status is produced by fetchBalances on 404', async () => {
    const error = new Error('Not found');
    error.response = { status: 404 };
    mockLoadAccount.mockRejectedValue(error);

    const result = await fetchBalances('GUNFUNDED');

    expect(result.status).toBe(BalancesStatus.Unfunded);
  });

  it('note: Idle and Loading statuses are UI-only states not produced by this module', () => {
    // This is a documentation test confirming that Idle and Loading are
    // managed by the UI layer (e.g., React component state), not by
    // fetchBalances itself. fetchBalances only produces: Loaded, Unfunded,
    // or throws Error.
    expect(BalancesStatus.Idle).toBeDefined();
    expect(BalancesStatus.Loading).toBeDefined();
    // But they are not returned by this module under any circumstances.
  });
});

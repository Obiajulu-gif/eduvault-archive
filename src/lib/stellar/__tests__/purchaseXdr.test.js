import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockCheckBuyerTrustline,
  mockGetAccount,
  mockSimulateTransaction,
  mockPrepareTransaction,
  mockIsSimulationError,
  mockScValToNative,
  mockBuild,
  mockToXDR,
} = vi.hoisted(() => ({
  mockCheckBuyerTrustline: vi.fn(),
  mockGetAccount: vi.fn(),
  mockSimulateTransaction: vi.fn(),
  mockPrepareTransaction: vi.fn(),
  mockIsSimulationError: vi.fn(),
  mockScValToNative: vi.fn(),
  mockBuild: vi.fn(),
  mockToXDR: vi.fn(() => 'unsigned-xdr'),
}));

vi.mock('@/lib/stellar/horizonClient', () => ({
  checkBuyerTrustline: mockCheckBuyerTrustline,
}));

vi.mock('@stellar/stellar-sdk', () => {
  class FakeAddress {
    constructor(value) {
      this.value = value;
    }
    toScVal() {
      return { type: 'address', value: this.value };
    }
  }

  class FakeContract {
    constructor(id) {
      this.id = id;
    }
    call(method, ...args) {
      return { method, args, contract: this.id };
    }
  }

  class FakeTransactionBuilder {
    constructor(account, opts) {
      this.account = account;
      this.opts = opts;
      this.operations = [];
    }
    addOperation(op) {
      this.operations.push(op);
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      mockBuild(this);
      return { toXDR: mockToXDR, operations: this.operations };
    }
  }

  return {
    Address: FakeAddress,
    BASE_FEE: '100',
    Contract: FakeContract,
    TransactionBuilder: FakeTransactionBuilder,
    Networks: { PUBLIC: 'Public Global Stellar Network ; September 2015', TESTNET: 'Test SDF Network ; September 2015' },
    nativeToScVal: (value, opts) => ({ value, opts }),
    scValToNative: mockScValToNative,
    rpc: {
      Server: class FakeServer {
        constructor(url) {
          this.url = url;
        }
        getAccount(...args) {
          return mockGetAccount(...args);
        }
        simulateTransaction(...args) {
          return mockSimulateTransaction(...args);
        }
        prepareTransaction(...args) {
          return mockPrepareTransaction(...args);
        }
      },
      Api: {
        isSimulationError: (...args) => mockIsSimulationError(...args),
      },
    },
  };
});

describe('purchaseXdr — pre-flight checks before signing (#674)', () => {
  const buyerAddress = 'GBUYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const assetContractId = 'CASSETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    mockCheckBuyerTrustline.mockReset();
    mockGetAccount.mockReset();
    mockSimulateTransaction.mockReset();
    mockPrepareTransaction.mockReset();
    mockIsSimulationError.mockReset();
    mockScValToNative.mockReset();
    mockBuild.mockClear();
    mockToXDR.mockClear();

    process.env.NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID = 'CPURCHASEMANAGERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    process.env.NEXT_PUBLIC_ACCEPTED_ASSET = 'USDC';

    mockGetAccount.mockResolvedValue({ accountId: () => buyerAddress });
    mockIsSimulationError.mockReturnValue(false);
    mockSimulateTransaction.mockResolvedValue({ result: { retval: 'retval-placeholder' } });
    mockScValToNative.mockReturnValue(true); // asset allowed, by default
    mockPrepareTransaction.mockImplementation(async (tx) => tx);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  function makeItem(overrides = {}) {
    return {
      _id: 'material-1',
      price: 10,
      assetContractId,
      ...overrides,
    };
  }

  it('throws a missing_trustline error before ever building a transaction', async () => {
    mockCheckBuyerTrustline.mockResolvedValue({
      hasTrustline: false,
      issuer: 'GISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      instructions: { message: 'Your wallet does not have an active trustline for USDC.', steps: ['step one'] },
    });

    const { buildPurchaseTransactionXdr } = await import('../purchaseXdr');

    await expect(
      buildPurchaseTransactionXdr({ buyerAddress, item: makeItem(), transactionReference: 'ref-1' })
    ).rejects.toMatchObject({
      code: 'missing_trustline',
      assetCode: 'USDC',
    });

    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('does not check a trustline for the native asset', async () => {
    mockScValToNative.mockReturnValue(true);

    const { buildPurchaseTransactionXdr } = await import('../purchaseXdr');
    await buildPurchaseTransactionXdr({
      buyerAddress,
      item: makeItem({ assetCode: 'XLM' }),
      transactionReference: 'ref-2',
    });

    expect(mockCheckBuyerTrustline).not.toHaveBeenCalled();
  });

  it('proceeds to build the transaction when the trustline check passes', async () => {
    mockCheckBuyerTrustline.mockResolvedValue({ hasTrustline: true, balance: '100', issuer: 'GISSUER' });

    const { buildPurchaseTransactionXdr } = await import('../purchaseXdr');
    const xdr = await buildPurchaseTransactionXdr({
      buyerAddress,
      item: makeItem(),
      transactionReference: 'ref-3',
    });

    expect(xdr).toBe('unsigned-xdr');
    expect(mockCheckBuyerTrustline).toHaveBeenCalledWith(buyerAddress, 'USDC', undefined);
  });

  it('throws an asset_not_allowed error when the contract rejects the resolved asset', async () => {
    mockCheckBuyerTrustline.mockResolvedValue({ hasTrustline: true, balance: '100', issuer: 'GISSUER' });
    mockScValToNative.mockReturnValue(false); // is_asset_allowed → false

    const { buildPurchaseTransactionXdr } = await import('../purchaseXdr');

    await expect(
      buildPurchaseTransactionXdr({ buyerAddress, item: makeItem(), transactionReference: 'ref-4' })
    ).rejects.toMatchObject({
      code: 'asset_not_allowed',
      assetContractId,
    });

    // The trustline check succeeded, but the transaction must never be built
    // once the on-chain allowlist rejects the asset (#674: "wrong issuer
    // cannot be used for checkout").
    expect(mockPrepareTransaction).not.toHaveBeenCalled();
  });

  it('surfaces a simulation error verifying the asset without a generic crash', async () => {
    mockCheckBuyerTrustline.mockResolvedValue({ hasTrustline: true, balance: '100', issuer: 'GISSUER' });
    mockIsSimulationError.mockReturnValue(true);
    mockSimulateTransaction.mockResolvedValue({ error: 'host invocation failed' });

    const { buildPurchaseTransactionXdr } = await import('../purchaseXdr');

    await expect(
      buildPurchaseTransactionXdr({ buyerAddress, item: makeItem(), transactionReference: 'ref-5' })
    ).rejects.toThrow(/Unable to verify payment asset/);
  });

  it('passes an explicit item.assetIssuer override through to the trustline check', async () => {
    mockCheckBuyerTrustline.mockResolvedValue({ hasTrustline: true, balance: '100', issuer: 'GCUSTOM' });

    const { buildPurchaseTransactionXdr } = await import('../purchaseXdr');
    await buildPurchaseTransactionXdr({
      buyerAddress,
      item: makeItem({ assetIssuer: 'GCUSTOMISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' }),
      transactionReference: 'ref-6',
    });

    expect(mockCheckBuyerTrustline).toHaveBeenCalledWith(
      buyerAddress,
      'USDC',
      'GCUSTOMISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
    );
  });
});

import { createElement } from 'react';
import { vi } from 'vitest';

// WalletProvider.jsx pulls in @creit-tech/stellar-wallets-kit (and, via
// @/lib/wallet/kit, its /modules/utils submodule) at import time — code that
// probes for browser wallet extensions and, in this environment, hits a
// version mismatch with @stellar/freighter-api. UI tests only need the
// WalletContext/WalletStatus values, so the wallet SDK is stubbed out here
// to keep component rendering free of any real wallet/browser dependency.
vi.mock('@creit-tech/stellar-wallets-kit', () => ({
  StellarWalletsKit: {
    init: vi.fn(),
    on: vi.fn(() => () => {}),
    getAddress: vi.fn(async () => ({ address: null })),
    authModal: vi.fn(async () => ({ address: null })),
    disconnect: vi.fn(async () => {}),
    signTransaction: vi.fn(async () => ({ signedTxXdr: '' })),
    signAuthEntry: vi.fn(async () => ({ signedAuthEntry: '' })),
  },
  KitEventType: {
    WALLET_SELECTED: 'WALLET_SELECTED',
    STATE_UPDATED: 'STATE_UPDATED',
    DISCONNECT: 'DISCONNECT',
  },
}));

vi.mock('@/lib/wallet/kit', () => ({
  horizon: {},
  ensureKitInitialized: vi.fn(),
  StellarWalletsKit: {
    init: vi.fn(),
    on: vi.fn(() => () => {}),
  },
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
}));

import { WalletContext, WalletStatus } from '@/providers/WalletProvider';

/**
 * Dummy Stellar address used by default in the mock wallet context.
 * Not a real/funded account — just a stand-in with the right shape for
 * components that slice/format it for display.
 */
export const MOCK_WALLET_ADDRESS =
  'GDUMMY7TESTWALLETADDRESSFORVITEST0000000000000000000000';

/**
 * Builds a connected wallet context value with a dummy session, matching
 * the shape produced by the real WalletProvider (see src/providers/WalletProvider.jsx).
 */
export function createConnectedWalletValue(overrides = {}) {
  const address = overrides.address ?? MOCK_WALLET_ADDRESS;

  return {
    state: {
      status: WalletStatus.Connected,
      session: {
        address,
        network: { passphrase: 'Test SDF Network ; September 2015' },
        walletId: 'mock-wallet',
      },
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    signTransaction: vi.fn(),
    signAuthEntry: vi.fn(),
    isConnected: true,
    address,
    balances: {
      status: 'loaded',
      snapshot: { native: { balance: '100.0000000' } },
    },
    refreshBalances: vi.fn(),
    ...overrides,
  };
}

/**
 * Builds a disconnected (idle) wallet context value — no session, no address.
 */
export function createDisconnectedWalletValue(overrides = {}) {
  return {
    state: { status: WalletStatus.Idle },
    connect: vi.fn(),
    disconnect: vi.fn(),
    signTransaction: vi.fn(),
    signAuthEntry: vi.fn(),
    isConnected: false,
    address: null,
    balances: { status: 'idle' },
    refreshBalances: vi.fn(),
    ...overrides,
  };
}

/**
 * Mock wallet provider for UI tests. Wraps children in the real WalletContext
 * (so `useWallet()` works unmodified) with a connected-by-default dummy
 * session — no StellarWalletsKit initialization or browser wallet extension
 * required.
 *
 * Usage:
 *   render(
 *     <MockWalletProvider value={createDisconnectedWalletValue()}>
 *       <Navbar />
 *     </MockWalletProvider>
 *   );
 */
export function MockWalletProvider({ children, value }) {
  const contextValue = value ?? createConnectedWalletValue();
  return createElement(WalletContext.Provider, { value: contextValue }, children);
}

'use client';

import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StellarWalletsKit } from '@creit-tech/stellar-wallets-kit/sdk';
import { KitEventType } from '@creit-tech/stellar-wallets-kit/types';

import { ensureKitInitialized, NETWORK_PASSPHRASE } from '@/lib/wallet/kit';
import { fetchBalances, BalancesStatus } from '@/lib/wallet/balance';

export const WalletStatus = Object.freeze({
  Initializing: 'initializing',
  Idle: 'idle',
  Connecting: 'connecting',
  Connected: 'connected',
  Locked: 'locked',
  Unsupported: 'unsupported',
  Expired: 'expired',
  Error: 'error',
});

export const WalletContext = createContext(null);

const SESSION_STORAGE_KEY = 'eduvault.wallet.session.v1';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24;

export function WalletProvider({ children }) {
  const [state, setState] = useState({ status: WalletStatus.Initializing });

  const [balancesState, setBalancesState] = useState({
    status: BalancesStatus.Idle,
  });

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const lastWalletIdRef = useRef(null);

  const persistSession = useCallback((session) => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        address: session.address,
        walletId: session.walletId ?? null,
        passphrase: session.network.passphrase,
        persistedAt: Date.now(),
      }),
    );
  }, []);

  const clearPersistedSession = useCallback(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  }, []);

  const loadPersistedSession = useCallback(() => {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed.address !== 'string' ||
        typeof parsed.persistedAt !== 'number'
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }, []);

  // Monotonic token for balance fetches — lets us ignore stale responses
  // when multiple refreshes overlap (e.g. address change while a manual
  // refresh is in flight).
  const balanceFetchTokenRef = useRef(0);

  // -------------------------------------------------------------------------
  // Balance loading
  // -------------------------------------------------------------------------

  const loadBalancesFor = useCallback(async (address) => {
    const token = ++balanceFetchTokenRef.current;
    setBalancesState({ status: BalancesStatus.Loading });

    try {
      const result = await fetchBalances(address);
      if (token !== balanceFetchTokenRef.current) return;

      if (result.status === 'unfunded') {
        setBalancesState({ status: BalancesStatus.Unfunded });
      } else {
        setBalancesState({
          status: BalancesStatus.Loaded,
          snapshot: result.snapshot,
        });
      }
    } catch (err) {
      if (token !== balanceFetchTokenRef.current) return;
      setBalancesState({
        status: BalancesStatus.Error,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }, []);

  const refreshBalances = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== WalletStatus.Connected) return;
    await loadBalancesFor(current.session.address);
  }, [loadBalancesFor]);

  const connectedAddress =
    state.status === WalletStatus.Connected ? state.session.address : null;

  useEffect(() => {
    if (!connectedAddress) {
      balanceFetchTokenRef.current++;
      // eslint-disable-next-line
      setBalancesState({ status: BalancesStatus.Idle });
      return;
    }
    loadBalancesFor(connectedAddress);
  }, [connectedAddress, loadBalancesFor]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        ensureKitInitialized();

        let address;
        try {
          const result = await StellarWalletsKit.getAddress();
          address = result.address;
        } catch {
          address = undefined;
        }

        if (cancelled) return;

        const persisted = loadPersistedSession();
        if (persisted && Date.now() - persisted.persistedAt > SESSION_TTL_MS) {
          clearPersistedSession();
          setState({ status: WalletStatus.Expired });
          return;
        }

        if (address) {
          const session = {
            address,
            network: { passphrase: NETWORK_PASSPHRASE },
            walletId: persisted?.walletId ?? lastWalletIdRef.current,
          };
          setState({
            status: WalletStatus.Connected,
            session,
          });
          persistSession(session);
        } else {
          setState(persisted ? { status: WalletStatus.Expired } : { status: WalletStatus.Idle });
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          status: WalletStatus.Error,
          error:
            err instanceof Error
              ? err
              : new Error('Failed to initialize wallet kit'),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clearPersistedSession, loadPersistedSession, persistSession]);

  useEffect(() => {
    const unsubSelected = StellarWalletsKit.on(
      KitEventType.WALLET_SELECTED,
      (event) => {
        lastWalletIdRef.current = event.payload.id ?? null;
      },
    );

    const unsubState = StellarWalletsKit.on(
      KitEventType.STATE_UPDATED,
      (event) => {
        const { address, networkPassphrase } = event.payload;

        if (!address) {
          setState({ status: WalletStatus.Locked });
          return;
        }

        if (networkPassphrase !== NETWORK_PASSPHRASE) {
          setState({
            status: WalletStatus.Unsupported,
            reason: 'wrong-network',
            actualPassphrase: networkPassphrase,
          });
          return;
        }

        setState({
          status: WalletStatus.Connected,
          session: {
            address,
            network: { passphrase: networkPassphrase },
            walletId: lastWalletIdRef.current,
          },
        });
        persistSession({
          address,
          network: { passphrase: networkPassphrase },
          walletId: lastWalletIdRef.current,
        });
      },
    );

    const unsubDisconnect = StellarWalletsKit.on(
      KitEventType.DISCONNECT,
      () => {
        lastWalletIdRef.current = null;
        clearPersistedSession();
        setState({ status: WalletStatus.Idle });
      },
    );

    return () => {
      unsubSelected();
      unsubState();
      unsubDisconnect();
    };
  }, [clearPersistedSession, persistSession]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const connect = useCallback(async () => {
    if (stateRef.current.status === WalletStatus.Connecting) return;

    setState({ status: WalletStatus.Connecting });
    try {
      const { address } = await StellarWalletsKit.authModal();

      if (address) {
        const session = {
          address,
          network: { passphrase: NETWORK_PASSPHRASE },
          walletId: lastWalletIdRef.current,
        };
        setState({
          status: WalletStatus.Connected,
          session,
        });
        persistSession(session);
      } else {
        setState({ status: WalletStatus.Locked });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isDismissal = /clos|cancel|reject|dismiss/i.test(message);

      if (isDismissal) {
        setState({ status: WalletStatus.Idle });
      } else {
        setState({
          status: WalletStatus.Error,
          error: err instanceof Error ? err : new Error(message),
        });
      }
    }
  }, [persistSession]);

  const disconnect = useCallback(async () => {
    try {
      await StellarWalletsKit.disconnect();
    } catch {
      // Some modules (e.g. stateless wallets like Albedo) may not implement
      // disconnect. Fine — DISCONNECT event resets state, or we fall through.
    }
    lastWalletIdRef.current = null;
    clearPersistedSession();
    setState({ status: WalletStatus.Idle });
  }, [clearPersistedSession]);

  const assertConnected = useCallback(() => {
    const current = stateRef.current;
    if (current.status !== WalletStatus.Connected) {
      throw new Error(
        `Cannot sign while wallet is in state "${current.status}"`,
      );
    }
    return current.session.address;
  }, []);

  const signTransaction = useCallback(
    async (xdr, opts) => {
      const address = opts?.address ?? assertConnected();
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
        address,
        networkPassphrase: NETWORK_PASSPHRASE,
      });
      return signedTxXdr;
    },
    [assertConnected],
  );

  const signAuthEntry = useCallback(
    async (entryXdr, opts) => {
      const address = opts?.address ?? assertConnected();
      const { signedAuthEntry } = await StellarWalletsKit.signAuthEntry(
        entryXdr,
        {
          address,
          networkPassphrase: NETWORK_PASSPHRASE,
        },
      );
      return signedAuthEntry;
    },
    [assertConnected],
  );

  const value = useMemo(() => {
    const isConnected = state.status === WalletStatus.Connected;
    return {
      state,
      connect,
      disconnect,
      signTransaction,
      signAuthEntry,
      isConnected,
      address: isConnected ? state.session.address : null,
      balances: balancesState,
      refreshBalances,
    };
  }, [
    state,
    connect,
    disconnect,
    signTransaction,
    signAuthEntry,
    balancesState,
    refreshBalances
  ]);

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

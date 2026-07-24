'use client';

import { useWallet } from '@/hooks/useWallet';
import { WalletStatus } from '@/providers/WalletProvider';
import { isMainnet } from '@/lib/config/chain';

const BTN_BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60';

const BTN_PRIMARY =
  `${BTN_BASE} bg-indigo-600 text-white shadow-sm hover:bg-indigo-500 focus-visible:ring-indigo-500 disabled:hover:bg-indigo-600`;

const BTN_GHOST =
  `${BTN_BASE} bg-transparent text-slate-700 hover:bg-slate-100 focus-visible:ring-slate-400 disabled:hover:bg-transparent`;

const BTN_DANGER =
  `${BTN_BASE} bg-transparent text-red-600 hover:bg-red-50 focus-visible:ring-red-400`;

const CARD =
  'flex flex-col gap-2 rounded-lg border border-slate-200 bg-white/50 p-3 backdrop-blur-sm';

export function WalletButton() {
  const { state, connect, disconnect } = useWallet();

  switch (state.status) {
    case WalletStatus.Initializing:
      return (
        <button disabled className={BTN_GHOST} aria-busy="true" aria-label="Loading wallet">
          <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400" aria-hidden="true" />
          <span>Loading wallet…</span>
        </button>
      );

    case WalletStatus.Idle:
      return (
        <button onClick={connect} className={BTN_PRIMARY} aria-label="Connect wallet">
          Connect wallet
        </button>
      );

    case WalletStatus.Connecting:
      return (
        <button disabled className={BTN_PRIMARY} aria-busy="true" aria-label="Opening wallet connection">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white/80" aria-hidden="true" />
          <span>Opening wallet…</span>
        </button>
      );

    case WalletStatus.Connected: {
      const { address } = state.session;
      const short = `${address.slice(0, 4)}…${address.slice(-4)}`;
      return (
        <div className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white/70 py-1 pl-3 pr-1 shadow-sm" role="group" aria-label="Wallet connection status">
          <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
          <span className="font-mono text-sm text-slate-700">{short}</span>
          <button onClick={disconnect} className={BTN_DANGER} aria-label={`Disconnect wallet ${short}`}>
            Disconnect
          </button>
        </div>
      );
    }

    case WalletStatus.Locked:
      return (
        <div className={`${CARD} border-amber-200 bg-amber-50/70`} role="alert">
          <p className="text-sm text-amber-800">
            Your wallet is locked or hasn&apos;t granted access to EduVault.
          </p>
          <button onClick={connect} className={`${BTN_PRIMARY} self-start`} aria-label="Unlock and reconnect wallet">
            Unlock and reconnect
          </button>
        </div>
      );

    case WalletStatus.Unsupported:
      return (
        <div className={`${CARD} border-amber-200 bg-amber-50/70`} role="alert">
          <p className="text-sm text-amber-800">
            Your wallet is on the wrong network. Switch to{' '}
            <span className="font-semibold">
              {isMainnet ? 'Mainnet' : 'Testnet'}
            </span>{' '}
            in your wallet and reconnect.
          </p>
          <button onClick={disconnect} className={`${BTN_GHOST} self-start`} aria-label="Disconnect wallet">
            Disconnect
          </button>
        </div>
      );

    case WalletStatus.Error:
      return (
        <button onClick={connect} className={BTN_PRIMARY} aria-label="Reconnect wallet">
          Connect wallet
        </button>
      );

    case WalletStatus.Expired:
      return (
        <div className={`${CARD} border-amber-200 bg-amber-50/70`} role="alert">
          <p className="text-sm text-amber-800">
            Wallet session expired. Reconnect to continue using protected actions.
          </p>
          <button onClick={connect} className={`${BTN_PRIMARY} self-start`} aria-label="Reconnect wallet">
            Reconnect wallet
          </button>
        </div>
      );

    default:
      return null;
  }
}

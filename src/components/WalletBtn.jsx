// components/WalletButton.jsx
'use client';

import { useWallet } from '@/hooks/useWallet';
import { WalletStatus } from '@/providers/WalletProvider';

/**
 * Reference consumer of `useWallet`. Every wallet-facing surface (upload CTA,
 * purchase button, auth gate) should branch on `state.status` the same way —
 * no ad-hoc `isConnected && !isLocked` chains.
 *
 * Alternative: the kit ships its own `createButton` / profile modal if you
 * prefer to delegate the UI entirely. This component is for when you want
 * bespoke copy and layout.
 */

// Shared Tailwind class sets — extracted so variants stay consistent across
// the switch arms. Kept as module-level constants (not inside the component)
// so we don't re-allocate the strings on every render.
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
        <button disabled className={BTN_GHOST}>
          <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400" />
          Loading…
        </button>
      );

    case WalletStatus.Idle:
      return (
        <button onClick={connect} className={BTN_PRIMARY}>
          Connect wallet
        </button>
      );

    case WalletStatus.Connecting:
      return (
        <button disabled className={BTN_PRIMARY}>
          <span className="h-2 w-2 animate-pulse rounded-full bg-white/80" />
          Opening wallet…
        </button>
      );

    case WalletStatus.Connected: {
      const { address } = state.session;
      const short = `${address.slice(0, 4)}…${address.slice(-4)}`;
      return (
        <div className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white/70 py-1 pl-3 pr-1 shadow-sm">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="font-mono text-sm text-slate-700">{short}</span>
          <button onClick={disconnect} className={BTN_DANGER}>
            Disconnect
          </button>
        </div>
      );
    }

    case WalletStatus.Locked:
      return (
        <div className={`${CARD} border-amber-200 bg-amber-50/70`}>
          <p className="text-sm text-amber-800">
            Your wallet is locked or hasn&apos;t granted access to EduVault.
          </p>
          <button onClick={connect} className={`${BTN_PRIMARY} self-start`}>
            Unlock and reconnect
          </button>
        </div>
      );

    case WalletStatus.Unsupported:
      return (
        <div className={`${CARD} border-amber-200 bg-amber-50/70`}>
          <p className="text-sm text-amber-800">
            Your wallet is on the wrong network. Switch to{' '}
            <span className="font-semibold">
              {process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'PUBLIC'
                ? 'Mainnet'
                : 'Testnet'}
            </span>{' '}
            in your wallet and reconnect.
          </p>
          <button onClick={disconnect} className={`${BTN_GHOST} self-start`}>
            Disconnect
          </button>
        </div>
      );

    case WalletStatus.Error:
      return (
        <button onClick={connect} className={BTN_PRIMARY}>
          Connect wallet
        </button>
      );

    case WalletStatus.Expired:
      return (
        <div className={`${CARD} border-amber-200 bg-amber-50/70`}>
          <p className="text-sm text-amber-800">
            Wallet session expired. Reconnect to continue using protected actions.
          </p>
          <button onClick={connect} className={`${BTN_PRIMARY} self-start`}>
            Reconnect wallet
          </button>
        </div>
      );

    default:
      return null;
  }
}

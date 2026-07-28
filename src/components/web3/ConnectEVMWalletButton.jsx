"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";

const BTN_BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60";

export default function ConnectEVMWalletButton() {
  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openAccountModal,
        openChainModal,
        openConnectModal,
        authenticationStatus,
        mounted,
      }) => {
        const ready = mounted && authenticationStatus !== "loading";
        const connected =
          ready &&
          account &&
          chain &&
          (!authenticationStatus || authenticationStatus === "authenticated");

        return (
          <div
            {...(!ready && {
              "aria-hidden": true,
              style: { opacity: 0, pointerEvents: "none", userSelect: "none" },
            })}
          >
            {(() => {
              if (!connected) {
                return (
                  <button
                    type="button"
                    onClick={openConnectModal}
                    className={`${BTN_BASE} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-blue-500`}
                  >
                    Connect EVM wallet
                  </button>
                );
              }

              if (chain.unsupported) {
                return (
                  <button
                    type="button"
                    onClick={openChainModal}
                    className={`${BTN_BASE} border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 focus-visible:ring-amber-500`}
                  >
                    Wrong network
                  </button>
                );
              }

              return (
                <div className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white/70 py-1 pl-3 pr-1 shadow-sm">
                  <button
                    type="button"
                    onClick={openChainModal}
                    className="flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
                  >
                    {chain.iconUrl && (
                      <img
                        alt={chain.name ?? "Chain icon"}
                        src={chain.iconUrl}
                        className="h-4 w-4"
                      />
                    )}
                    {chain.name}
                  </button>
                  <button
                    type="button"
                    onClick={openAccountModal}
                    className="font-mono text-sm text-slate-700 hover:text-slate-900"
                  >
                    {account.displayName}
                  </button>
                  <button
                    type="button"
                    onClick={openAccountModal}
                    className={`${BTN_BASE} bg-transparent text-red-600 hover:bg-red-50 focus-visible:ring-red-400 px-2 py-1 text-xs`}
                  >
                    Disconnect
                  </button>
                </div>
              );
            })()}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

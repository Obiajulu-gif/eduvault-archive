"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";

import dynamic from "next/dynamic";

import { config } from "@/lib/web3/config";
import { TransactionProvider } from "@/providers/TransactionProvider";
import RainbowKitProvider from "@/providers/RainbowKitProvider";

const WalletProvider = dynamic(
  () => import("@/providers/WalletProvider").then((mod) => mod.WalletProvider),
  { ssr: false },
);

export default function Web3Provider({ children }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 60 * 1000,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={config}>
      <RainbowKitProvider>
        <QueryClientProvider client={queryClient}>
          <WalletProvider>
            <TransactionProvider>{children}</TransactionProvider>
          </WalletProvider>
        </QueryClientProvider>
      </RainbowKitProvider>
    </WagmiProvider>
  );
}

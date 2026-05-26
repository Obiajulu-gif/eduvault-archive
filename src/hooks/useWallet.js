'use client';

import { useContext } from 'react';

import { WalletContext } from '@/providers/WalletProvider';

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error('useWallet must be used inside <WalletProvider>');
  }
  return ctx;
}

// lib/wallet/kit.js
//
// Single source of truth for the StellarWalletsKit singleton and the
// Horizon server used for read-only account queries (balances, sequence).
// Nothing outside lib/wallet/ should import from these libraries directly.
//
// API reference: https://stellarwalletskit.dev/

import { StellarWalletsKit } from '@creit-tech/stellar-wallets-kit/sdk';
import { defaultModules } from '@creit-tech/stellar-wallets-kit/modules/utils';
import { Horizon, Networks } from '@stellar/stellar-sdk';

const NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'TESTNET';

export const NETWORK_PASSPHRASE =
  NETWORK === 'PUBLIC' ? Networks.PUBLIC : Networks.TESTNET;


const HORIZON_URL =
  NETWORK === 'PUBLIC'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org';

export const horizon = new Horizon.Server(HORIZON_URL);

let initialized = false;

export function ensureKitInitialized() {
  if (initialized) return;
  StellarWalletsKit.init({
    modules: defaultModules(),
    network: NETWORK_PASSPHRASE,
  });
  initialized = true;
}

export { StellarWalletsKit };
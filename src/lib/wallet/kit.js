import { StellarWalletsKit } from '@creit-tech/stellar-wallets-kit';
import { Horizon } from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE, HORIZON_URL } from '@/lib/config/chain';

export const horizon = new Horizon.Server(HORIZON_URL);

let initialized = false;
let modulesPromise = null;

async function loadDefaultModules() {
  if (!modulesPromise) {
    modulesPromise = import('@creit-tech/stellar-wallets-kit/modules/utils');
  }
  const { defaultModules } = await modulesPromise;
  return defaultModules();
}

export async function ensureKitInitialized() {
  if (initialized) return;
  StellarWalletsKit.init({
    modules: await loadDefaultModules(),
    network: NETWORK_PASSPHRASE,
  });
  initialized = true;
}

export { StellarWalletsKit };
export { NETWORK_PASSPHRASE };

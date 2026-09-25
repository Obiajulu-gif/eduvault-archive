import { EvmEntitlementProvider } from './providers/EvmEntitlementProvider.js';
import { SorobanEntitlementProvider } from './providers/SorobanEntitlementProvider.js';

const defaultEvmProvider = new EvmEntitlementProvider();
const defaultSorobanProvider = new SorobanEntitlementProvider();

/**
 * Returns the appropriate EntitlementProvider instance based on the chain identifier.
 * @param {string} [chain] - Chain identifier (e.g. 'evm', 'ethereum', 'polygon', 'soroban', 'stellar').
 * @returns {import('./EntitlementProvider.js').EntitlementProvider}
 */
export function getEntitlementProvider(chain = 'evm') {
  const normalized = String(chain || '').toLowerCase();
  if (normalized === 'soroban' || normalized === 'stellar') {
    return defaultSorobanProvider;
  }
  return defaultEvmProvider;
}

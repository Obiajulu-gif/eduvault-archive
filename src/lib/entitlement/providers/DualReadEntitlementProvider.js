import { EntitlementProvider } from '../EntitlementProvider.js';

/**
 * Compatibility provider used during the EVM-to-Soroban payment migration.
 * Soroban is authoritative for new purchases, while archived EVM purchases
 * remain readable so existing buyers do not lose access during cutover.
 */
export class DualReadEntitlementProvider extends EntitlementProvider {
  constructor({ primaryProvider, legacyProvider } = {}) {
    super();
    this.chainType = 'dual-read';
    this.primaryProvider = primaryProvider;
    this.legacyProvider = legacyProvider;
  }

  async checkAccess(params = {}) {
    if (!this.primaryProvider || !this.legacyProvider) {
      return { hasAccess: false, state: 'UNAVAILABLE', source: 'dual-read-provider' };
    }

    const primary = await this.primaryProvider.checkAccess({
      ...params,
      chain: params.chain || 'soroban',
    });
    if (primary?.hasAccess) {
      return {
        ...primary,
        source: `dual-read:${primary.source || this.primaryProvider.getChainType()}`,
        compatibilityPath: 'soroban-primary',
      };
    }

    const legacy = await this.legacyProvider.checkAccess({
      ...params,
      chain: 'evm',
    });
    if (legacy?.hasAccess) {
      return {
        ...legacy,
        source: `dual-read:${legacy.source || this.legacyProvider.getChainType()}`,
        compatibilityPath: 'evm-legacy',
        fallbackFrom: primary?.source || this.primaryProvider.getChainType(),
      };
    }

    return {
      hasAccess: false,
      state: primary?.state || legacy?.state || 'UNLICENSED',
      source: 'dual-read:none',
      primary,
      legacy,
    };
  }

  async grantAccess(params = {}) {
    if (!this.primaryProvider) {
      return { success: false, entitlementId: null };
    }
    return this.primaryProvider.grantAccess({
      ...params,
      chain: params.chain || 'soroban',
    });
  }

  async revokeAccess(params = {}) {
    if (!this.primaryProvider) {
      return { success: false };
    }
    return this.primaryProvider.revokeAccess({
      ...params,
      chain: params.chain || 'soroban',
    });
  }
}

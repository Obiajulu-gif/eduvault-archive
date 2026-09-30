import { describe, expect, it, vi } from 'vitest';
import { DualReadEntitlementProvider } from '../../src/lib/entitlement/providers/DualReadEntitlementProvider.js';

function providerFor({ chainType, result }) {
  return {
    getChainType: () => chainType,
    checkAccess: vi.fn().mockResolvedValue(result),
    grantAccess: vi.fn().mockResolvedValue({ success: true, entitlementId: `${chainType}:material-1:GABC` }),
    revokeAccess: vi.fn().mockResolvedValue({ success: true }),
  };
}

describe('shared payment transition contract behavior', () => {
  it.each([
    ['archived EVM contract', providerFor({
      chainType: 'evm',
      result: { hasAccess: true, state: 'FINALIZED', source: 'evm-db' },
    })],
    ['future Soroban contract', providerFor({
      chainType: 'soroban',
      result: { hasAccess: true, state: 'FINALIZED', source: 'soroban-ledger' },
    })],
  ])('%s exposes the entitlement behavior required by checkout', async (_label, provider) => {
    const access = await provider.checkAccess({ walletAddress: 'GABC', materialId: 'material-1' });
    const grant = await provider.grantAccess({ walletAddress: 'GABC', materialId: 'material-1' });
    const revoke = await provider.revokeAccess({ walletAddress: 'GABC', materialId: 'material-1' });

    expect(access).toMatchObject({ hasAccess: true, state: 'FINALIZED' });
    expect(grant.success).toBe(true);
    expect(revoke.success).toBe(true);
  });

  it('uses the same compatibility adapter when Soroban is unavailable but EVM has an archived purchase', async () => {
    const provider = new DualReadEntitlementProvider({
      primaryProvider: providerFor({
        chainType: 'soroban',
        result: { hasAccess: false, state: 'UNLICENSED', source: 'soroban-ledger' },
      }),
      legacyProvider: providerFor({
        chainType: 'evm',
        result: { hasAccess: true, state: 'FINALIZED', source: 'evm-db' },
      }),
    });

    const access = await provider.checkAccess({ walletAddress: '0xabc', materialId: 'material-1' });

    expect(access).toMatchObject({
      hasAccess: true,
      compatibilityPath: 'evm-legacy',
      fallbackFrom: 'soroban-ledger',
    });
  });
});

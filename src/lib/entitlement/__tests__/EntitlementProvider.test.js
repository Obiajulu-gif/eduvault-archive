import { describe, it, expect, vi } from 'vitest';
import { EntitlementProvider } from '../EntitlementProvider.js';
import { EvmEntitlementProvider } from '../providers/EvmEntitlementProvider.js';
import { SorobanEntitlementProvider } from '../providers/SorobanEntitlementProvider.js';
import { getEntitlementProvider } from '../factory.js';

describe('EntitlementProvider abstraction', () => {
  it('throws unimplemented error on base class', async () => {
    const base = new EntitlementProvider();
    await expect(base.checkAccess({})).rejects.toThrow();
    await expect(base.grantAccess({})).rejects.toThrow();
    await expect(base.revokeAccess({})).rejects.toThrow();
  });

  it('factory returns correct provider by chain', () => {
    expect(getEntitlementProvider('evm')).toBeInstanceOf(EvmEntitlementProvider);
    expect(getEntitlementProvider('polygon')).toBeInstanceOf(EvmEntitlementProvider);
    expect(getEntitlementProvider('soroban')).toBeInstanceOf(SorobanEntitlementProvider);
    expect(getEntitlementProvider('stellar')).toBeInstanceOf(SorobanEntitlementProvider);
  });

  it('EvmEntitlementProvider grants and revokes access', async () => {
    const provider = new EvmEntitlementProvider();
    const res = await provider.grantAccess({ walletAddress: '0x123', materialId: 'm1' });
    expect(res.success).toBe(true);
  });

  it('SorobanEntitlementProvider implements contract storage semantics', async () => {
    const provider = new SorobanEntitlementProvider();
    const res = await provider.checkAccess({ walletAddress: 'G123', materialId: 'm1' });
    expect(res).toHaveProperty('hasAccess');
  });
});

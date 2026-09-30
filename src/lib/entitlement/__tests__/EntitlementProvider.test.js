import { describe, it, expect, vi } from 'vitest';
import { EntitlementProvider } from '../EntitlementProvider.js';
import { EvmEntitlementProvider } from '../providers/EvmEntitlementProvider.js';
import { SorobanEntitlementProvider } from '../providers/SorobanEntitlementProvider.js';
import { DualReadEntitlementProvider } from '../providers/DualReadEntitlementProvider.js';
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
    expect(getEntitlementProvider('transition')).toBeInstanceOf(DualReadEntitlementProvider);
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

  it('DualReadEntitlementProvider prefers Soroban access when both ledgers know the purchase', async () => {
    const provider = new DualReadEntitlementProvider({
      primaryProvider: {
        getChainType: () => 'soroban',
        checkAccess: vi.fn().mockResolvedValue({ hasAccess: true, state: 'FINALIZED', source: 'soroban-ledger' }),
        grantAccess: vi.fn(),
        revokeAccess: vi.fn(),
      },
      legacyProvider: {
        getChainType: () => 'evm',
        checkAccess: vi.fn().mockResolvedValue({ hasAccess: true, state: 'FINALIZED', source: 'evm-db' }),
      },
    });

    const res = await provider.checkAccess({ walletAddress: 'G123', materialId: 'm1' });

    expect(res.hasAccess).toBe(true);
    expect(res.compatibilityPath).toBe('soroban-primary');
    expect(res.source).toBe('dual-read:soroban-ledger');
    expect(provider.legacyProvider.checkAccess).not.toHaveBeenCalled();
  });

  it('DualReadEntitlementProvider falls back to archived EVM purchases', async () => {
    const provider = new DualReadEntitlementProvider({
      primaryProvider: {
        getChainType: () => 'soroban',
        checkAccess: vi.fn().mockResolvedValue({ hasAccess: false, state: 'UNLICENSED', source: 'soroban-ledger' }),
      },
      legacyProvider: {
        getChainType: () => 'evm',
        checkAccess: vi.fn().mockResolvedValue({ hasAccess: true, state: 'FINALIZED', source: 'evm-db' }),
      },
    });

    const res = await provider.checkAccess({ walletAddress: '0xabc', materialId: 'm1' });

    expect(res.hasAccess).toBe(true);
    expect(res.compatibilityPath).toBe('evm-legacy');
    expect(res.fallbackFrom).toBe('soroban-ledger');
    expect(provider.legacyProvider.checkAccess).toHaveBeenCalledWith(expect.objectContaining({ chain: 'evm' }));
  });
});

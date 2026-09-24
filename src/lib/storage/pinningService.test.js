import { describe, expect, it, vi } from 'vitest'
import { pinWithQuorum, resolveFromGateways } from './pinningService'

describe('multi-provider pinning', () => {
  it('requires two matching independent pins', async () => {
    const providers = [
      { name: 'a', pinFile: vi.fn().mockResolvedValue({ cid: 'cid-1' }) },
      { name: 'b', pinFile: vi.fn().mockResolvedValue({ cid: 'cid-1' }) },
    ]
    await expect(pinWithQuorum(providers, 'pinFile', {})).resolves.toMatchObject({ cid: 'cid-1', replicas: [{ provider: 'a' }, { provider: 'b' }] })
  })

  it('fails closed when quorum is not met or CIDs disagree', async () => {
    await expect(pinWithQuorum([{ name: 'a', pinFile: async () => ({ cid: 'x' }) }], 'pinFile', {})).rejects.toThrow('At least 2')
    await expect(pinWithQuorum([
      { name: 'a', pinFile: async () => ({ cid: 'x' }) },
      { name: 'b', pinFile: async () => ({ cid: 'y' }) },
    ], 'pinFile', {})).rejects.toThrow('different CIDs')
  })

  it('falls back to the next healthy gateway', async () => {
    const providers = [
      { name: 'a', gatewayUrl: async () => 'https://a/ipfs/cid' },
      { name: 'b', gatewayUrl: async () => 'https://b/ipfs/cid' },
    ]
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: true })
    await expect(resolveFromGateways('cid', providers, fetchImpl)).resolves.toEqual({ url: 'https://b/ipfs/cid', provider: 'b' })
  })
})

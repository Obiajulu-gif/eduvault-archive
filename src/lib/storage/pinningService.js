import { validateGatewayUrl, validatePinataResponse } from '@/lib/api/storage'

export class PinningQuorumError extends Error {
  constructor(message, results = []) {
    super(message)
    this.name = 'PinningQuorumError'
    this.results = results
  }
}

export function createPinataProvider(pinata) {
  return {
    name: 'pinata',
    async pinFile(file) {
      const result = validatePinataResponse(await pinata.upload.public.file(file), 'document')
      return { cid: result.cid }
    },
    async pinJson(value) {
      const result = validatePinataResponse(await pinata.upload.public.json(value), 'metadata')
      return { cid: result.cid }
    },
    async gatewayUrl(cid) {
      return validateGatewayUrl(await pinata.gateways.public.convert(cid), 'content')
    },
  }
}

export function createHttpPinningProvider({ endpoint, token, gateway }) {
  return {
    name: 'secondary',
    async pinFile(file) {
      const body = new FormData()
      body.set('file', file)
      const response = await fetch(endpoint, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body })
      if (!response.ok) throw new Error(`secondary pinning failed (${response.status})`)
      const data = await response.json()
      const cid = data.cid || data.IpfsHash
      if (!cid) throw new Error('secondary pinning response omitted CID')
      return { cid }
    },
    async pinJson(value) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(value),
      })
      if (!response.ok) throw new Error(`secondary pinning failed (${response.status})`)
      const data = await response.json()
      const cid = data.cid || data.IpfsHash
      if (!cid) throw new Error('secondary pinning response omitted CID')
      return { cid }
    },
    async gatewayUrl(cid) {
      return `${gateway.replace(/\/$/, '')}/ipfs/${cid}`
    },
  }
}

export async function pinWithQuorum(providers, operation, value, quorum = 2) {
  if (providers.length < quorum) throw new PinningQuorumError(`At least ${quorum} independent pinning providers are required.`)
  const settled = await Promise.allSettled(providers.map((provider) => provider[operation](value)))
  const successes = settled.flatMap((result, index) => result.status === 'fulfilled'
    ? [{ provider: providers[index].name, ...result.value }]
    : [])
  if (successes.length < quorum) throw new PinningQuorumError(`Pinning quorum not met (${successes.length}/${quorum}).`, settled)
  const cid = successes[0].cid
  if (successes.some((result) => result.cid !== cid)) throw new PinningQuorumError('Pinning providers returned different CIDs.', successes)
  return { cid, replicas: successes }
}

export async function resolveFromGateways(cid, providers, fetchImpl = fetch) {
  const failures = []
  for (const provider of providers) {
    try {
      const url = await provider.gatewayUrl(cid)
      const response = await fetchImpl(url, { method: 'HEAD' })
      if (response.ok) return { url, provider: provider.name }
      failures.push(`${provider.name}:${response.status}`)
    } catch (error) {
      failures.push(`${provider.name}:${error.message}`)
    }
  }
  throw new Error(`No healthy gateway for ${cid}: ${failures.join(', ')}`)
}

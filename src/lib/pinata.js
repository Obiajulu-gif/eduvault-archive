// utils/config.ts
// server only
import { PinataSDK } from "pinata";
import { createHttpPinningProvider, createPinataProvider } from '@/lib/storage/pinningService'
import { createSandboxStorageAdapter, isSandboxMode } from '@/lib/sandbox/adapters'

const productionPinata = new PinataSDK({
  pinataJwt: process.env.PINATA_JWT,
  pinataGateway: process.env.NEXT_PUBLIC_GATEWAY_URL,
});

// Sandbox is opt-in so production retains the Pinata SDK path. The fake adapter
// never reads credentials or calls a remote gateway.
export const pinata = isSandboxMode() ? createSandboxStorageAdapter() : productionPinata;

export function getPinningProviders() {
  if (isSandboxMode()) {
    // The upload route requires two independent replicas. Two local adapters
    // model that contract while returning the same deterministic CID.
    return [
      { ...createPinataProvider(createSandboxStorageAdapter()), name: 'sandbox-primary' },
      { ...createPinataProvider(createSandboxStorageAdapter()), name: 'sandbox-replica' },
    ]
  }
  const providers = [createPinataProvider(pinata)]
  if (process.env.SECONDARY_PINNING_ENDPOINT && process.env.SECONDARY_IPFS_GATEWAY) {
    providers.push(createHttpPinningProvider({
      endpoint: process.env.SECONDARY_PINNING_ENDPOINT,
      token: process.env.SECONDARY_PINNING_TOKEN,
      gateway: process.env.SECONDARY_IPFS_GATEWAY,
    }))
  }
  return providers
}

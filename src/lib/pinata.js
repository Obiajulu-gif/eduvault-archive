// utils/config.ts
// server only
import { PinataSDK } from "pinata";
import { createHttpPinningProvider, createPinataProvider } from '@/lib/storage/pinningService'

export const pinata = new PinataSDK({
  pinataJwt: process.env.PINATA_JWT,
  pinataGateway: process.env.NEXT_PUBLIC_GATEWAY_URL,
});

export function getPinningProviders() {
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

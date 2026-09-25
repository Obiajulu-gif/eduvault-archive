import { mainnet, sepolia } from "wagmi/chains";

export const SUPPORTED_CHAINS = [mainnet, sepolia];

export function getChainById(chainId) {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId) || null;
}

export function isChainSupported(chainId) {
  return SUPPORTED_CHAINS.some((c) => c.id === chainId);
}

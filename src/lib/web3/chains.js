import { mainnet, sepolia, celoSepolia } from "wagmi/chains";

export const SUPPORTED_CHAINS = [mainnet, sepolia];
export const UPLOAD_CHAIN = celoSepolia;

export function getChainById(chainId) {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId) || null;
}

export function isChainSupported(chainId) {
  return SUPPORTED_CHAINS.some((c) => c.id === chainId);
}

export function isUploadChain(chainId) {
  return chainId === UPLOAD_CHAIN.id;
}

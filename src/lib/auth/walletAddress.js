import { Address } from "@stellar/stellar-sdk";

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export function normalizeWalletAddress(value) {
  const address = String(value || "").trim();
  if (!address) return null;
  if (EVM_ADDRESS_PATTERN.test(address)) {
    return address.toLowerCase();
  }
  try {
    Address.fromString(address.toUpperCase());
    return address.toLowerCase();
  } catch {
    return null;
  }
}

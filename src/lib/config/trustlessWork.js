import { Networks } from "@stellar/stellar-sdk";

export const TRUSTLESS_WORK_NETWORK_CONFIG = {
  [Networks.TESTNET]: {
    contractId: process.env.TRUSTLESS_WORK_CONTRACT_ID_TESTNET || process.env.NEXT_PUBLIC_TRUSTLESS_WORK_CONTRACT_ID || "",
  },
  [Networks.PUBLIC]: {
    contractId: process.env.TRUSTLESS_WORK_CONTRACT_ID_MAINNET || "",
  },
};

export function getTrustlessWorkConfig(networkPassphrase = Networks.TESTNET) {
  return TRUSTLESS_WORK_NETWORK_CONFIG[networkPassphrase] || null;
}

export const ESCROW_STATUS = {
  PENDING: "pending",
  FUNDED: "funded",
  RELEASED: "released",
  REFUNDED: "refunded",
  DISPUTED: "disputed",
};

export const MILESTONE_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  COMPLETED: "completed",
};

export const PAYOUT_STATUS = {
  PENDING: "pending",
  CLAIMED: "claimed",
};

"use client";

import {
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  ACCEPTED_ASSET,
  NATIVE_ASSET,
  NETWORK_PASSPHRASE,
  PURCHASE_MANAGER_CONTRACT_ID,
  STELLAR_RPC_URL,
} from "@/lib/config/chain";
import { checkBuyerTrustline } from "@/lib/stellar/horizonClient";

const STROOPS_PER_UNIT = 10_000_000;

async function sha256Bytes(value) {
  const encoded = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return new Uint8Array(digest);
}

async function materialIdToBytes(materialId) {
  const value = String(materialId || "");
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  return sha256Bytes(value);
}

function amountToStroops(amount) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Invalid purchase amount");
  }
  return BigInt(Math.round(parsed * STROOPS_PER_UNIT));
}

function resolveAssetContractId(item) {
  return (
    item.assetContractId ||
    item.paymentAssetContractId ||
    item.stellarAssetContractId ||
    process.env.NEXT_PUBLIC_STELLAR_PAYMENT_ASSET_CONTRACT_ID ||
    process.env.NEXT_PUBLIC_XLM_SAC_CONTRACT_ID ||
    ""
  );
}

/**
 * The Stellar asset *code* (as opposed to the Soroban asset contract id
 * resolved above) a cart item pays with. No cart item field carries the
 * contract id *and* a code together today, so this mirrors
 * getSupportedPaymentAssets()'s own fallback chain (lib/config/assets.js):
 * an explicit per-item override, else the deployment's configured
 * ACCEPTED_ASSET. Used only for the pre-flight trustline check below — the
 * actual payment still settles via the resolved asset contract id.
 */
function resolveAssetCode(item) {
  return item.assetCode || item.asset || ACCEPTED_ASSET;
}

/**
 * Fails fast, before the wallet is ever asked to sign, when the buyer can't
 * actually complete this purchase: no trustline for a non-native payment
 * asset (#674). Checking after signing/submission just trades a clear
 * pre-flight error for an opaque on-chain transfer failure the buyer
 * already paid a network fee for.
 */
async function assertBuyerCanPayWithAsset(buyerAddress, assetCode, issuerAddress) {
  if (assetCode === NATIVE_ASSET) return;

  const trustlineCheck = await checkBuyerTrustline(buyerAddress, assetCode, issuerAddress);
  if (!trustlineCheck.hasTrustline) {
    const instructions = trustlineCheck.instructions?.steps?.join("\n") || "";
    const error = new Error(
      trustlineCheck.instructions?.message ||
        `Your wallet does not have an active trustline for ${assetCode}.${instructions ? `\n${instructions}` : ""}`
    );
    error.code = "missing_trustline";
    error.assetCode = assetCode;
    error.issuer = trustlineCheck.issuer;
    throw error;
  }
}

/**
 * Confirms the resolved payment asset contract is actually approved by
 * PurchaseManager (its own is_asset_allowed read call, no auth required)
 * before the buyer signs anything. Cart items resolve their asset contract
 * id from client-provided/cached fields with no server-side validation
 * (resolveAssetContractId above), so a stale item or a mismatched
 * NEXT_PUBLIC_* env value could otherwise build a transaction against an
 * asset the contract itself would reject at settlement — after the wallet
 * prompt and the network fee are already spent (#674).
 */
async function assertAssetIsAllowed(server, account, assetContractId) {
  const contract = new Contract(PURCHASE_MANAGER_CONTRACT_ID);
  const probe = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("is_asset_allowed", new Address(assetContractId).toScVal()))
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(probe);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Unable to verify payment asset: ${simulation.error}`);
  }

  const isAllowed = scValToNative(simulation.result.retval);
  if (!isAllowed) {
    const error = new Error(
      "This item's configured payment asset is not approved by the purchase contract. Please refresh and try again."
    );
    error.code = "asset_not_allowed";
    error.assetContractId = assetContractId;
    throw error;
  }
}

export async function buildPurchaseTransactionXdr({ buyerAddress, item, transactionReference }) {
  if (!PURCHASE_MANAGER_CONTRACT_ID) {
    throw new Error("Purchase manager contract is not configured");
  }
  if (!buyerAddress) {
    throw new Error("Buyer wallet address is required");
  }

  const materialId = item._id || item.id || item.materialId;
  if (!materialId) {
    throw new Error("Cart item is missing a material id");
  }

  const assetContractId = resolveAssetContractId(item);
  if (!assetContractId) {
    throw new Error("Payment asset contract is not configured");
  }

  const assetCode = resolveAssetCode(item);
  await assertBuyerCanPayWithAsset(buyerAddress, assetCode, item.assetIssuer);

  const server = new rpc.Server(STELLAR_RPC_URL);
  const account = await server.getAccount(buyerAddress);

  await assertAssetIsAllowed(server, account, assetContractId);

  const contract = new Contract(PURCHASE_MANAGER_CONTRACT_ID);
  const materialBytes = await materialIdToBytes(materialId);
  const txRef = new TextEncoder().encode(transactionReference || `cart-${Date.now()}`);

  const operation = contract.call(
    "purchase",
    new Address(buyerAddress).toScVal(),
    nativeToScVal(materialBytes, { type: "bytes" }),
    new Address(assetContractId).toScVal(),
    nativeToScVal(amountToStroops(item.stellarPrice ?? item.price), { type: "i128" }),
    nativeToScVal(txRef, { type: "bytes" }),
  );

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(transaction);
  return prepared.toXDR();
}

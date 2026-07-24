import { Address, Networks, scValToNative, TransactionBuilder } from "@stellar/stellar-sdk";

export class WalletIntentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalletIntentError";
    this.code = code;
  }
}

function mismatch(field) {
  throw new WalletIntentError("wallet_intent_mismatch", `Wallet intent mismatch: ${field}`);
}

function normalizedDecimal(value) {
  const match = String(value ?? "").trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) mismatch("amount");
  const fraction = (match[2] || "").replace(/0+$/, "");
  return `${BigInt(match[1]).toString()}${fraction ? `.${fraction}` : ""}`;
}

export function formatWalletIntent(intent) {
  const network = intent.networkPassphrase === Networks.PUBLIC
    ? "Stellar Public Network"
    : intent.networkPassphrase === Networks.TESTNET
      ? "Stellar Testnet"
      : "Unknown (signing blocked)";
  const summary = String(intent.summary || "")
    .replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const unit = intent.operation === "payment" ? intent.asset : "contract units";
  return [
    `Requested action: ${summary}`,
    `Network: ${network}`,
    intent.contractId && `Contract: ${intent.contractId}`,
    intent.destination && `Recipient: ${intent.destination}`,
    intent.amount !== undefined && `Amount: ${intent.amount} ${unit || ""}`.trim(),
    intent.functionName && `Action: ${intent.functionName}`,
  ].filter(Boolean).join("\n");
}

export function verifyWalletTransactionIntent({
  xdr,
  address,
  networkPassphrase,
  intent,
}) {
  if (!intent || typeof intent !== "object" || !String(intent.summary || "").trim()) {
    throw new WalletIntentError("wallet_intent_required", "A human-readable wallet intent is required");
  }
  if (intent.networkPassphrase !== networkPassphrase) mismatch("network");

  let transaction;
  try {
    transaction = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  } catch {
    throw new WalletIntentError("wallet_xdr_invalid", "The transaction payload is invalid");
  }

  if (transaction.source !== address) mismatch("signing account");
  const operations = transaction.operations || [];
  if (operations.length !== (intent.operationCount ?? 1)) mismatch("operation count");
  const operation = operations[intent.operationIndex ?? 0];
  if (!operation || operation.type !== intent.operation) mismatch("operation type");
  if (operation.source && operation.source !== address) mismatch("operation source");

  if (operation.type === "payment") {
    if (intent.destination && operation.destination !== intent.destination) mismatch("recipient");
    if (intent.amount !== undefined && normalizedDecimal(operation.amount) !== normalizedDecimal(intent.amount)) {
      mismatch("amount");
    }
    const assetCode = operation.asset?.isNative?.() ? "XLM" : operation.asset?.code;
    if (intent.asset && assetCode !== intent.asset) mismatch("asset");
    if (intent.assetIssuer && operation.asset?.issuer !== intent.assetIssuer) mismatch("asset issuer");
  } else if (operation.type === "invokeHostFunction") {
    let invocation;
    try {
      invocation = operation.func.invokeContract();
    } catch {
      mismatch("contract invocation");
    }
    const contractId = Address.fromScAddress(invocation.contractAddress()).toString();
    if (!intent.contractId || contractId !== intent.contractId) mismatch("contract");
    if (intent.functionName && invocation.functionName().toString() !== intent.functionName) mismatch("contract function");
    if (intent.amount !== undefined) {
      if (!Number.isSafeInteger(intent.amountArgIndex)) mismatch("amount argument index");
      const actualAmount = scValToNative(invocation.args()[intent.amountArgIndex]);
      if (BigInt(actualAmount) !== BigInt(intent.amount)) mismatch("amount");
    }
  }

  return { source: transaction.source, operation: operation.type };
}

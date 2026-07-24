import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { PURCHASE_MANAGER_CONTRACT_ID, STELLAR_RPC_URL } from "@/lib/config/chain";

export class PurchaseVerificationError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function native(value) {
  return scValToNative(xdr.ScVal.fromXDR(value, "base64"));
}

async function readPurchaseEvent(transactionHash, ledger, fetchImpl = fetch) {
  const response = await fetchImpl(STELLAR_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getEvents",
      params: { startLedger: ledger, filters: [{ type: "contract", contractIds: [PURCHASE_MANAGER_CONTRACT_ID] }], pagination: { limit: 100 } },
    }),
  });
  if (!response.ok) throw new PurchaseVerificationError("rpc_unavailable", "Unable to read purchase events", 503);
  const payload = await response.json();
  const event = payload.result?.events?.find((item) => (item.txHash || item.transactionHash) === transactionHash);
  if (!event) throw new PurchaseVerificationError("event_missing", "Purchase event not found in finalized transaction");
  const topics = event.topic.map(native);
  if (topics[0] !== "purchase" || topics[1] !== "completed") {
    throw new PurchaseVerificationError("wrong_event", "Transaction did not emit purchase.completed");
  }
  const fields = native(event.value);
  return { contractId: event.contractId, materialId: Buffer.from(fields[1]).toString("hex"), buyer: String(fields[2]), asset: String(fields[4]), amount: BigInt(fields[5]) };
}

export async function verifyPurchaseTransaction({ transactionHash, buyerAddress, materialId, asset, amount, rpcClient, fetchImpl }) {
  if (!/^[a-f0-9]{64}$/i.test(String(transactionHash || ""))) {
    throw new PurchaseVerificationError("invalid_hash", "A valid transaction hash is required", 400);
  }
  const server = rpcClient || new rpc.Server(STELLAR_RPC_URL);
  let transaction;
  try { transaction = await server.getTransaction(transactionHash); }
  catch { throw new PurchaseVerificationError("rpc_unavailable", "Unable to verify transaction", 503); }
  if (transaction.status === "NOT_FOUND") throw new PurchaseVerificationError("pending", "Transaction is not finalized", 202);
  if (transaction.status !== "SUCCESS") throw new PurchaseVerificationError("failed", "Transaction was not successful");

  const event = await readPurchaseEvent(transactionHash, transaction.ledger, fetchImpl);
  if (event.contractId !== PURCHASE_MANAGER_CONTRACT_ID) throw new PurchaseVerificationError("wrong_contract", "Wrong purchase contract");
  if (event.buyer.toLowerCase() !== buyerAddress.toLowerCase()) throw new PurchaseVerificationError("wrong_buyer", "Purchase buyer does not match the authenticated wallet", 403);
  if (event.materialId !== String(materialId).toLowerCase()) throw new PurchaseVerificationError("wrong_material", "Purchase material does not match");
  if (asset && event.asset !== asset) throw new PurchaseVerificationError("wrong_asset", "Purchase asset does not match quote");
  if (amount != null && event.amount !== BigInt(amount)) throw new PurchaseVerificationError("wrong_amount", "Purchase amount does not match quote");
  return { transactionHash, ledger: transaction.ledger, ...event };
}

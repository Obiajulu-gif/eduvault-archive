import { xdr, scValToNative } from "@stellar/stellar-sdk";

function scValFromBase64(base64) {
  return xdr.ScVal.fromXDR(base64, "base64");
}

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function decodeTopics(rawEvent) {
  const topics = rawEvent.topic ?? rawEvent.topics ?? [];
  return topics.map((t) => scValToNative(scValFromBase64(t)));
}

// `data_format = "vec"` contract events encode their non-#[topic] fields as
// an ordered Vec, in struct declaration order.
function decodeDataVec(rawEvent) {
  const raw = rawEvent.value ?? rawEvent.data;
  const base64 = typeof raw === "string" ? raw : raw?.xdr;
  if (!base64) return [];
  const native = scValToNative(scValFromBase64(base64));
  return Array.isArray(native) ? native : [native];
}

// Topic layout: [event-name-0, event-name-1, ...#[topic] fields in
// declaration order]. See soroban/contracts/*/src/lib.rs for the source
// #[contractevent] definitions these mirror.
const EVENT_PARSERS = {
  // PurchaseCompletedEvent (purchase-manager): topics = ["purchase",
  // "completed", purchase_id, material_id, buyer]; data = [seller, asset,
  // amount, platform_fee, seller_net_amount, entitlement_active, transaction_id]
  "purchase.completed": (topics, data) => ({
    type: "purchase.completed",
    purchaseId: topics[2] != null ? String(topics[2]) : null,
    materialId: bytesToHex(topics[3]),
    buyerAddress: topics[4],
    sellerAddress: data[0] ?? null,
    asset: data[1] ?? null,
    amount: data[2] != null ? String(data[2]) : null,
  }),
  // PurchaseRefundedEvent (purchase-manager): topics = ["purchase",
  // "refunded", purchase_id, material_id, buyer]; data = [asset,
  // refund_amount, entitlement_revoked]. Terminal, on-chain-authoritative
  // revocation — the indexer uses this to invalidate any cached entitlement
  // for this (materialId, buyer) pair without waiting on TTL expiry.
  "purchase.refunded": (topics, data) => ({
    type: "purchase.refunded",
    purchaseId: topics[2] != null ? String(topics[2]) : null,
    materialId: bytesToHex(topics[3]),
    buyerAddress: topics[4],
    asset: data[0] ?? null,
    refundAmount: data[1] != null ? String(data[1]) : null,
    entitlementRevoked: data[2] !== false,
  }),
  // DisputeOpenedEvent (purchase-manager): topics = ["dispute", "opened",
  // purchase_id, material_id, opener]; data = [reason, opened_ledger].
  // Settlement moves Pending -> Disputed, which freezes buyer access until
  // the dispute is resolved (dispute.resolved is not yet indexed).
  "dispute.opened": (topics) => ({
    type: "dispute.opened",
    purchaseId: topics[2] != null ? String(topics[2]) : null,
    materialId: bytesToHex(topics[3]),
    opener: topics[4] ?? null,
  }),
  // MaterialRegisteredEvent (material-registry): topics = ["material",
  // "registered", material_id, creator]
  "material.registered": (topics) => ({
    type: "material.registered",
    materialId: bytesToHex(topics[2]),
    creatorAddress: topics[3] ?? null,
  }),
};

/**
 * Decode a raw Soroban RPC `getEvents` event (base64-XDR `topic`/`value`)
 * into the plain JS shape `applyIndexedEvent` expects.
 *
 * Returns `null` for events with an unrecognized topic or that fail to
 * decode, so callers can skip them without failing the whole batch — this
 * keeps future/unknown contract event types from breaking the indexer.
 *
 * @param {object} rawEvent - raw event object from Soroban RPC `getEvents`
 * @returns {object|null}
 */
export function parseContractEvent(rawEvent) {
  if (!rawEvent) return null;

  let topics;
  let data;
  try {
    topics = decodeTopics(rawEvent);
    data = decodeDataVec(rawEvent);
  } catch {
    return null;
  }

  const [name0, name1] = topics;
  if (typeof name0 !== "string" || typeof name1 !== "string") return null;

  const parse = EVENT_PARSERS[`${name0}.${name1}`];
  if (!parse) return null;

  let parsed;
  try {
    parsed = parse(topics, data, rawEvent);
  } catch {
    return null;
  }

  return {
    ...parsed,
    id: rawEvent.id ?? rawEvent.pagingToken ?? undefined,
    ledger: rawEvent.ledger ?? null,
    transactionHash: rawEvent.txHash ?? rawEvent.transactionHash ?? null,
    contractId: rawEvent.contractId ?? null,
    timestamp: rawEvent.ledgerClosedAt ?? null,
    topic: rawEvent.topic ?? rawEvent.topics ?? null,
  };
}

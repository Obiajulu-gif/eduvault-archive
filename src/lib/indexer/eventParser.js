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
  // PayoutDistributedEvent (purchase-manager): topics = ["payout",
  // "distributed", purchase_id, material_id, recipient]; data = [role,
  // asset, amount, transaction_id]
  "payout.distributed": (topics, data) => ({
    type: "payout.distributed",
    purchaseId: topics[2] != null ? String(topics[2]) : null,
    materialId: bytesToHex(topics[3]),
    recipient: topics[4] ?? null,
    role: data[0] ?? null,
    asset: data[1] ?? null,
    amount: data[2] != null ? String(data[2]) : null,
  }),
  // DisputeResolvedEvent (purchase-manager): topics = ["dispute",
  // "resolved", purchase_id, material_id]; data = [resolution,
  // resolved_ledger]. resolution is a DisputeResolution enum (Unresolved /
  // RefundBuyer / ReleaseToCreator), decoded as its variant name.
  "dispute.resolved": (topics, data) => ({
    type: "dispute.resolved",
    purchaseId: topics[2] != null ? String(topics[2]) : null,
    materialId: bytesToHex(topics[3]),
    resolution: data[0] ?? null,
    resolvedLedger: data[1] ?? null,
  }),
  // EscrowReleasedEvent (purchase-manager): topics = ["escrow",
  // "released", purchase_id]; data = [material_id, asset, amount] — note
  // material_id is a data field, not a topic, for this event.
  "escrow.released": (topics, data) => ({
    type: "escrow.released",
    purchaseId: topics[2] != null ? String(topics[2]) : null,
    materialId: bytesToHex(data[0]),
    asset: data[1] ?? null,
    amount: data[2] != null ? String(data[2]) : null,
  }),
  // AdminTransferInitiatedEvent (purchase-manager): topics = ["admin",
  // "transfer_initiated", from]; data = [pending_admin]
  "admin.transfer_initiated": (topics, data) => ({
    type: "admin.transfer_initiated",
    from: topics[2] ?? null,
    pendingAdmin: data[0] ?? null,
  }),
  // AdminTransferAcceptedEvent (purchase-manager): topics = ["admin",
  // "transfer_accepted", new_admin]; data = []
  "admin.transfer_accepted": (topics) => ({
    type: "admin.transfer_accepted",
    newAdmin: topics[2] ?? null,
  }),
  // CreatorTierUpdatedEvent (purchase-manager): topics = ["creator",
  // "tier_updated", creator]; data = [tier]. tier is a CreatorTier enum
  // (Default / Tier1 / Tier2), decoded as its variant name.
  "creator.tier_updated": (topics, data) => ({
    type: "creator.tier_updated",
    creator: topics[2] ?? null,
    tier: data[0] ?? null,
  }),
  // BulkPurchaseCompletedEvent (purchase-manager): topics = ["purchase",
  // "bulk_completed", purchaser, material_id]; data = [recipient_count,
  // unit_price, total_paid, asset]
  "purchase.bulk_completed": (topics, data) => ({
    type: "purchase.bulk_completed",
    purchaser: topics[2] ?? null,
    materialId: bytesToHex(topics[3]),
    recipientCount: data[0] ?? null,
    unitPrice: data[1] != null ? String(data[1]) : null,
    totalPaid: data[2] != null ? String(data[2]) : null,
    asset: data[3] ?? null,
  }),
  // ScholarshipCreditsIssuedEvent (purchase-manager): topics =
  // ["scholarship", "credits_issued", grant_id, learner]; data = [issuer,
  // amount, expires_at]
  "scholarship.credits_issued": (topics, data) => ({
    type: "scholarship.credits_issued",
    grantId: topics[2] != null ? String(topics[2]) : null,
    learner: topics[3] ?? null,
    issuer: data[0] ?? null,
    amount: data[1] != null ? String(data[1]) : null,
    expiresAt: data[2] ?? null,
  }),
  // ScholarshipCreditsRedeemedEvent (purchase-manager): topics =
  // ["scholarship", "credits_redeemed", redemption_id, learner,
  // material_id]; data = [credits_used, remaining_credits]
  "scholarship.credits_redeemed": (topics, data) => ({
    type: "scholarship.credits_redeemed",
    redemptionId: topics[2] != null ? String(topics[2]) : null,
    learner: topics[3] ?? null,
    materialId: bytesToHex(topics[4]),
    creditsUsed: data[0] != null ? String(data[0]) : null,
    remainingCredits: data[1] != null ? String(data[1]) : null,
  }),
  // ScholarshipGrantRevokedEvent (purchase-manager): topics =
  // ["scholarship", "grant_revoked", grant_id, learner]; data = [issuer,
  // credits_revoked]
  "scholarship.grant_revoked": (topics, data) => ({
    type: "scholarship.grant_revoked",
    grantId: topics[2] != null ? String(topics[2]) : null,
    learner: topics[3] ?? null,
    issuer: data[0] ?? null,
    creditsRevoked: data[1] != null ? String(data[1]) : null,
  }),
  // ScholarshipCostUpdatedEvent (purchase-manager): topics =
  // ["scholarship", "cost_updated", material_id]; data = [credit_cost]
  "scholarship.cost_updated": (topics, data) => ({
    type: "scholarship.cost_updated",
    materialId: bytesToHex(topics[2]),
    creditCost: data[0] != null ? String(data[0]) : null,
  }),
  // ScholarshipIssuerUpdatedEvent (purchase-manager): topics =
  // ["scholarship", "issuer_updated", issuer]; data = [enabled]
  "scholarship.issuer_updated": (topics, data) => ({
    type: "scholarship.issuer_updated",
    issuer: topics[2] ?? null,
    enabled: data[0] !== false,
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
    // Operation index within the transaction — part of Soroban RPC's own
    // `getEvents` event shape; a canonical component of the event id (#630).
    operationIndex: Number.isInteger(rawEvent.operationIndex) ? rawEvent.operationIndex : null,
    contractId: rawEvent.contractId ?? null,
    timestamp: rawEvent.ledgerClosedAt ?? null,
    topic: rawEvent.topic ?? rawEvent.topics ?? null,
  };
}

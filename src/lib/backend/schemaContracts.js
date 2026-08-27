export const COLLECTIONS = {
  users: "users",
  materials: "materials",
  purchases: "purchases",
  entitlementCache: "entitlement_cache",
  syncState: "sync_state",
  syncEvents: "sync_events",
  collections: "collections",
  progress: "progress",
  deadLetterEvents: "dead_letter_events",
  materialHistory: "material_history",
  savedMaterials: "saved_materials",
  refunds: "refunds",
  refundAuditLog: "refund_audit_log",
  auditLedger: "audit_ledger",
  auditCheckpoints: "audit_checkpoints",
};

export const REQUIRED_INDEXES = {
  users: [
    { keys: { email: 1 }, options: { unique: true } },
    { keys: { walletAddressLower: 1 }, options: { sparse: true } },
  ],
  materials: [
    { keys: { userAddress: 1, createdAt: -1 } },
    { keys: { visibility: 1, createdAt: -1 } },
    { keys: { materialId: 1 }, options: { sparse: true } },
    { keys: { tokenId: 1 }, options: { unique: true, sparse: true } },
    { keys: { txHash: 1 }, options: { unique: true, sparse: true } },
    { keys: { updatedAt: -1 } },
    { keys: { category: 1 } },
    { keys: { subject: 1 } },
    { keys: { level: 1 } },
    { keys: { category: 1, subject: 1 } },
    {
      keys: { category: 1, price: 1 },
      options: { name: "materials_category_price_idx", background: true },
    },
    {
      keys: { title: "text", description: "text" },
      options: { name: "materials_text_idx", background: true },
    },
    {
      keys: { category: 1, price: 1, title: 1, description: 1 },
      options: { name: "materials_search_compound_idx", background: true },
    },
  ],
  purchases: [
    { keys: { buyerAddress: 1, createdAt: -1 } },
    { keys: { materialId: 1, buyerAddress: 1 }, options: { unique: true, sparse: true } },
    { keys: { chainTxHash: 1 }, options: { unique: true, sparse: true } },
  ],
  entitlement_cache: [
    { keys: { buyerAddress: 1, materialId: 1 }, options: { unique: true } },
    { keys: { active: 1, updatedAt: -1 } },
  ],
  sync_state: [{ keys: { source: 1 }, options: { unique: true } }],
  sync_events: [{ keys: { _id: 1 }, options: { unique: true } }],
  collections: [
    { keys: { creatorId: 1, createdAt: -1 } },
  ],
  progress: [
    { keys: { userId: 1, materialId: 1 }, options: { unique: true } },
    { keys: { completedAt: -1 } },
  ],
  dead_letter_events: [
    { keys: { _id: 1 }, options: { unique: true } },
    { keys: { status: 1 } },
    { keys: { retryCount: 1 } },
  ],
  material_history: [
    { keys: { materialId: 1, updatedAt: -1 } },
    { keys: { updatedBy: 1 } },
  ],
  saved_materials: [
    { keys: { walletAddress: 1, savedAt: -1 } },
    { keys: { walletAddress: 1, materialId: 1 }, options: { unique: true } },
  ],
  refunds: [
    // At most one *live* (non-rejected) refund claim per purchase. A claim
    // that reaches `settled` also blocks future claims via this index — the
    // defined behavior for duplicate/partial claims is "one effective refund
    // per purchase, ever". Rejected claims fall outside the filter so a buyer
    // can be re-invited to file a new claim after a rejection.
    {
      keys: { purchaseId: 1 },
      options: {
        name: "refunds_one_live_claim_per_purchase_idx",
        unique: true,
        partialFilterExpression: { status: { $ne: "rejected" } },
      },
    },
    { keys: { status: 1, updatedAt: 1 } },
    { keys: { txHash: 1 }, options: { sparse: true } },
    { keys: { idempotencyKey: 1 }, options: { unique: true, sparse: true } },
  ],
  refund_audit_log: [
    { keys: { refundId: 1, createdAt: 1 } },
    { keys: { correlationId: 1 } },
  ],
  audit_ledger: [
    { keys: { sequence: 1 }, options: { unique: true } },
    { keys: { operationId: 1 }, options: { unique: true } },
    { keys: { action: 1, createdAt: -1 } },
    { keys: { "target.type": 1, "target.id": 1, sequence: 1 } },
  ],
  audit_checkpoints: [
    { keys: { sequence: 1 }, options: { unique: true } },
  ],
};

export function applyTimestamps(record, now = new Date()) {
  const timestamp = now instanceof Date ? now : new Date(now);
  return {
    ...record,
    createdAt: record.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

export const EDITABLE_MATERIAL_FIELDS = [
  "title",
  "description",
  "price",
  "usageRights",
  "visibility",
  "thumbnailUrl",
  "category",
  "subject",
  "level",
];

export const IMMUTABLE_MATERIAL_FIELDS = [
  "storageKey",
  "userAddress",
  "materialId",
  "createdAt",
];

export function buildMaterialHistoryEntry({ materialId, previousDoc, update, updatedBy, changeReason, source }) {
  const changes = {};
  for (const key of EDITABLE_MATERIAL_FIELDS) {
    if (key in update && update[key] !== previousDoc?.[key]) {
      changes[key] = { from: previousDoc?.[key], to: update[key] };
    }
  }
  return {
    materialId,
    changes,
    version: (previousDoc?.version || 1) + 1,
    updatedBy,
    updatedAt: new Date(),
    changeReason: changeReason || null,
    source: source || "creator",
  };
}

/**
 * Retention Policy and Personal Data Inventory
 *
 * Each entry describes one collection (or storage category) in terms of:
 *   - piiFields:      fields considered personal data under GDPR Art. 4(1)
 *   - legalBasis:     GDPR Art. 6 / Art. 9 justification
 *   - retentionDays:  how long the record is kept after the triggering event
 *   - retentionEvent: which event starts the clock ("account_deletion", "last_activity", "transaction_date")
 *   - onDeletion:     what happens when a user requests erasure:
 *                       "delete"     – document is removed entirely
 *                       "anonymize"  – PII fields are replaced with placeholders; record is kept
 *                       "retain"     – kept as-is (legal obligation; no PII in practice)
 *   - notes:          human-readable rationale
 *
 * This file is the single source of truth consumed by:
 *   - src/lib/privacy/dataExportService.js   (what to include in a data export)
 *   - src/lib/privacy/deletionService.js     (which operations to run)
 *   - docs/privacy-data-retention.md         (auto-generated documentation)
 */

export const ANONYMIZED_WALLET = "0x0000000000000000000000000000000000000000";
export const ANONYMIZED_EMAIL  = "deleted@eduvault.invalid";
export const ANONYMIZED_NAME   = "[deleted]";
export const ANONYMIZED_TEXT   = "[redacted]";
export const ANONYMIZED_CID    = null;

/** Retention periods in days */
export const RETENTION = Object.freeze({
  /** Financial / accounting records: 7-year legal retention (varies by jurisdiction; use 2555 days = ~7 years) */
  FINANCIAL_YEARS_7: 2555,
  /** Auth audit trail: 90 days */
  AUTH_AUDIT_90: 90,
  /** Inactive session tokens: 7 days (matches token TTL) */
  SESSION_7: 7,
  /** User-deletable records: erased immediately on verified deletion request */
  IMMEDIATE: 0,
});

/**
 * The canonical personal-data inventory.
 * Keys match MongoDB collection names.
 */
export const DATA_INVENTORY = Object.freeze({

  // ── Identity & Profile ──────────────────────────────────────────────────
  users: {
    piiFields: [
      "walletAddress", "walletAddressLower",
      "email",
      "fullName", "displayName",
      "bio",
      "avatarCid", "avatarUrl",
      "institution", "country",
      "payoutWalletAddress", "payoutWalletAddressLower",
      "payoutNotes", "preferredPayoutCurrency",
    ],
    legalBasis: "consent",           // Art. 6(1)(a) – user signed up voluntarily
    retentionDays: RETENTION.IMMEDIATE,
    retentionEvent: "account_deletion",
    onDeletion: "delete",
    notes: "Profile document is deleted on confirmed erasure. Wallet address references in other collections are separately anonymized.",
    includeInExport: true,
  },

  // ── Authentication ───────────────────────────────────────────────────────
  refresh_tokens: {
    piiFields: ["userId"],
    legalBasis: "legitimate_interest", // Art. 6(1)(f) – session security
    retentionDays: RETENTION.SESSION_7,
    retentionEvent: "token_expiry",
    onDeletion: "delete",
    notes: "All refresh tokens for the user are revoked and deleted on account deletion.",
    includeInExport: true,
  },

  auth_challenges: {
    piiFields: ["account"],
    legalBasis: "legitimate_interest",
    retentionDays: RETENTION.AUTH_AUDIT_90,
    retentionEvent: "challenge_created",
    onDeletion: "delete",
    notes: "Short-lived challenge nonces; deleted by TTL index and explicitly on deletion.",
    includeInExport: false,
  },

  // ── Marketplace activity ─────────────────────────────────────────────────
  materials: {
    piiFields: ["userAddress"],
    legalBasis: "contract",           // Art. 6(1)(b) – publishing a listing
    retentionDays: RETENTION.IMMEDIATE,
    retentionEvent: "account_deletion",
    onDeletion: "anonymize",
    anonymizeMap: { userAddress: ANONYMIZED_WALLET },
    notes: "Listing metadata (title, description, CID) is kept for buyers who legitimately own it. Creator wallet is anonymized. IPFS content is unpinned.",
    includeInExport: true,
  },

  saved_materials: {
    piiFields: ["walletAddress"],
    legalBasis: "consent",
    retentionDays: RETENTION.IMMEDIATE,
    retentionEvent: "account_deletion",
    onDeletion: "delete",
    notes: "Bookmark records are deleted immediately.",
    includeInExport: true,
  },

  collections: {
    piiFields: ["creatorId"],
    legalBasis: "consent",
    retentionDays: RETENTION.IMMEDIATE,
    retentionEvent: "account_deletion",
    onDeletion: "delete",
    notes: "User-curated collections are deleted. Materials inside them are unaffected.",
    includeInExport: true,
  },

  progress: {
    piiFields: ["userId"],
    legalBasis: "consent",
    retentionDays: RETENTION.IMMEDIATE,
    retentionEvent: "account_deletion",
    onDeletion: "delete",
    notes: "Learning progress is deleted immediately.",
    includeInExport: true,
  },

  reviews: {
    piiFields: ["walletAddress"],
    legalBasis: "consent",
    retentionDays: RETENTION.IMMEDIATE,
    retentionEvent: "account_deletion",
    onDeletion: "anonymize",
    anonymizeMap: { walletAddress: ANONYMIZED_WALLET },
    notes: "Review text is kept for marketplace integrity; author wallet is anonymized.",
    includeInExport: true,
  },

  material_history: {
    piiFields: ["updatedBy"],
    legalBasis: "legitimate_interest",
    retentionDays: RETENTION.IMMEDIATE,
    retentionEvent: "account_deletion",
    onDeletion: "anonymize",
    anonymizeMap: { updatedBy: ANONYMIZED_WALLET },
    notes: "Version history entries have the actor wallet anonymized.",
    includeInExport: false,
  },

  // ── Financial / Audit (must be retained; only PII anonymized) ───────────
  purchases: {
    piiFields: ["buyerAddress"],
    legalBasis: "legal_obligation",   // Art. 6(1)(c) – accounting / tax law
    retentionDays: RETENTION.FINANCIAL_YEARS_7,
    retentionEvent: "transaction_date",
    onDeletion: "anonymize",
    anonymizeMap: { buyerAddress: ANONYMIZED_WALLET },
    notes: "Purchase records are retained for 7 years. Buyer wallet is anonymized on deletion request.",
    includeInExport: true,
  },

  entitlement_cache: {
    piiFields: ["buyerAddress"],
    legalBasis: "legal_obligation",
    retentionDays: RETENTION.FINANCIAL_YEARS_7,
    retentionEvent: "transaction_date",
    onDeletion: "anonymize",
    anonymizeMap: { buyerAddress: ANONYMIZED_WALLET },
    notes: "Entitlement cache is an operational mirror of on-chain state; buyer wallet is anonymized.",
    includeInExport: true,
  },

  ledger: {
    piiFields: [],
    legalBasis: "legal_obligation",
    retentionDays: RETENTION.FINANCIAL_YEARS_7,
    retentionEvent: "transaction_date",
    onDeletion: "retain",
    notes: "Immutable double-entry ledger. Contains no direct PII (uses wallet addresses only as account codes, which are anonymized in the purchases/entitlement_cache collections). Records are never deleted.",
    includeInExport: false,
  },

  // ── Webhooks ─────────────────────────────────────────────────────────────
  webhooks: {
    piiFields: ["userId"],
    legalBasis: "consent",
    retentionDays: RETENTION.IMMEDIATE,
    retentionEvent: "account_deletion",
    onDeletion: "delete",
    notes: "Webhook subscriptions and all delivery logs are deleted.",
    includeInExport: true,
  },

  webhook_deliveries: {
    piiFields: ["userId"],
    legalBasis: "consent",
    retentionDays: RETENTION.IMMEDIATE,
    retentionEvent: "account_deletion",
    onDeletion: "delete",
    notes: "Delivery log rows referencing the user are deleted.",
    includeInExport: false,
  },

  // ── Outbox / Sync ────────────────────────────────────────────────────────
  outbox: {
    piiFields: [],
    legalBasis: "legitimate_interest",
    retentionDays: RETENTION.IMMEDIATE,
    retentionEvent: "account_deletion",
    onDeletion: "delete",
    notes: "Pending outbox events for the user are deleted or cancelled before execution.",
    includeInExport: false,
  },

  // ── Upload Sessions ───────────────────────────────────────────────────────
  upload_sessions: {
    piiFields: ["ownerId"],
    legalBasis: "consent",
    retentionDays: RETENTION.IMMEDIATE,
    retentionEvent: "account_deletion",
    onDeletion: "delete",
    notes: "Incomplete or expired upload sessions are deleted.",
    includeInExport: false,
  },

  // ── Content Provenance ────────────────────────────────────────────────────
  material_manifests: {
    piiFields: [],
    legalBasis: "legitimate_interest",
    retentionDays: RETENTION.FINANCIAL_YEARS_7,
    retentionEvent: "transaction_date",
    onDeletion: "retain",
    notes: "Content-integrity manifests contain no direct PII and are retained for provenance.",
    includeInExport: false,
  },

  manifest_digest_anchors: {
    piiFields: [],
    legalBasis: "legitimate_interest",
    retentionDays: RETENTION.FINANCIAL_YEARS_7,
    retentionEvent: "transaction_date",
    onDeletion: "retain",
    notes: "Cryptographic digest anchors contain no PII.",
    includeInExport: false,
  },

  // ── IPFS / Pinata Storage Objects ────────────────────────────────────────
  ipfs_pins: {
    piiFields: [],
    legalBasis: "consent",
    retentionDays: RETENTION.IMMEDIATE,
    retentionEvent: "account_deletion",
    onDeletion: "delete",
    notes: "Avatar and material files pinned by the user are unpinned from Pinata unless other users hold entitlements to the material.",
    includeInExport: false,
  },
});

/**
 * Returns only the collections flagged for inclusion in a data export.
 */
export function exportableCollections() {
  return Object.entries(DATA_INVENTORY)
    .filter(([, entry]) => entry.includeInExport)
    .map(([collection]) => collection);
}

/**
 * Returns only collections with onDeletion === "anonymize".
 */
export function collectionsToAnonymize() {
  return Object.entries(DATA_INVENTORY)
    .filter(([, entry]) => entry.onDeletion === "anonymize")
    .map(([collection, entry]) => ({ collection, anonymizeMap: entry.anonymizeMap || {} }));
}

/**
 * Returns only collections with onDeletion === "delete".
 */
export function collectionsToDelete() {
  return Object.entries(DATA_INVENTORY)
    .filter(([, entry]) => entry.onDeletion === "delete")
    .map(([collection]) => collection);
}

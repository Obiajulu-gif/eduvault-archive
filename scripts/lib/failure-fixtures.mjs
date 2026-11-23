/**
 * Deterministic fixtures for rare failure modes and their repair paths (#881).
 *
 * Each fixture is a minimal, self-contained set of documents that reproduces
 * one rare but important failure state exactly as the integrity monitor
 * (scripts/lib/integrity-rules.mjs) sees it, plus the documented repair path.
 * `tests/backend/failure-fixtures.test.mjs` proves that every fixture
 *   - satisfies the current `$jsonSchema` validators (users, materials),
 *   - is detected by exactly the integrity rules it declares,
 *   - and, for automated/script repairs, is cleared by its repair path.
 *
 * Side-effect free (no DB connection on import), like integrity-rules.mjs.
 * All `_id`s start with `fa11ed` so fixture rows are easy to spot and remove,
 * and all timestamps are fixed offsets from FIXTURE_NOW.
 */

import { Double, ObjectId } from "mongodb";

export const FIXTURE_NOW = new Date("2026-01-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(FIXTURE_NOW.getTime() - days * DAY_MS);
const fixtureId = (n) => new ObjectId(`fa11ed${String(n).padStart(18, "0")}`);

// Shape-valid Stellar account strings (base32 A-Z2-7, 56 chars); fixtures never sign.
const account = (tag) => `G${tag}`.padEnd(56, "A");
const CREATOR = account("FIXTURECREATOR");
const BUYER = account("FIXTUREBUYER");
const TX_HASH = "fa11ed".padEnd(64, "0");

const IDS = Object.freeze({
  creator: fixtureId(1),
  buyer: fixtureId(2),
  material: fixtureId(3),
  missingMaterial: fixtureId(4),
  pendingPurchase: fixtureId(10),
  refundedPurchase: fixtureId(11),
  orphanedPurchase: fixtureId(12),
  orphanedEntitlement: fixtureId(20),
  duplicateProfileA: fixtureId(30),
  duplicateProfileB: fixtureId(31),
  // Dead-letter rows are keyed by the indexer's event identity string.
  deadLetter: "fa11ed-ledger-0000001-op-0001",
});

const profile = (_id, uuid, walletAddress, createdAt) => ({
  _id,
  uuid,
  walletAddress,
  walletAddressLower: walletAddress.toLowerCase(),
  displayName: "Fixture user",
  createdAt,
  updatedAt: createdAt,
});

// Baseline rows shared by fixtures. Identical in every fixture, so loading
// several fixtures upserts the same documents rather than conflicting.
const creatorProfile = profile(IDS.creator, "fa11ed00-0000-4000-8000-000000000001", CREATOR, daysAgo(120));
const buyerProfile = profile(IDS.buyer, "fa11ed00-0000-4000-8000-000000000002", BUYER, daysAgo(90));
const material = {
  _id: IDS.material,
  title: "Fixture: Organic Chemistry Notes",
  description: "Deterministic material used by failure-mode fixtures.",
  category: "science",
  price: new Double(12.5),
  asset: "USDC",
  userAddress: CREATOR,
  storageKey: "fixtures/organic-chemistry.pdf",
  createdAt: daysAgo(60),
  updatedAt: daysAgo(60),
};

/**
 * @typedef {object} FailureFixture
 * @property {string} id
 * @property {string} title
 * @property {string} failure      How the state arises in production.
 * @property {string[]} detectedBy Integrity rule ids that must flag it (exactly).
 * @property {Record<string, object[]>} documents Collection → documents.
 * @property {{kind: "automated"|"script"|"manual", command?: string, steps: string[], expected: string}} repair
 */

/** @type {ReadonlyArray<FailureFixture>} */
export const FAILURE_FIXTURES = Object.freeze([
  {
    id: "stale-pending-purchase-paid-onchain",
    title: "Purchase stuck in pending although its payment confirmed on-chain",
    failure:
      "The buyer's tab closed or POST /api/purchase timed out after the transaction was submitted, so the synchronous path never marked the purchase confirmed and access was never granted.",
    detectedBy: ["stale_pending_purchases"],
    documents: {
      users: [creatorProfile, buyerProfile],
      materials: [material],
      purchases: [
        {
          _id: IDS.pendingPurchase,
          materialId: String(IDS.material),
          buyerAddress: BUYER,
          status: "pending",
          transactionHash: TX_HASH,
          amount: "12.5",
          asset: "USDC",
          createdAt: daysAgo(3),
          updatedAt: daysAgo(3),
        },
      ],
    },
    repair: {
      kind: "automated",
      command: "curl -X POST -H \"Authorization: Bearer $STELLAR_WEBHOOK_SECRET\" http://localhost:3000/api/webhooks/stellar",
      steps: [
        "Confirm the payment landed: GET {horizon}/transactions/<transactionHash> returns successful: true.",
        "Trigger the reconciler (reconcilePendingPurchases) through the command above; it runs on the same schedule in production.",
        "It marks the purchase confirmed, grants the entitlement and sends the receipt and creator webhook.",
      ],
      expected: "Purchase status is `confirmed` with `confirmedAt`; the buyer holds an active entitlement; `stale_pending_purchases` no longer reports it.",
    },
  },
  {
    id: "orphaned-entitlement-after-refund",
    title: "Active entitlement left behind after its purchase was refunded",
    failure:
      "A refund settled but the entitlement-cache invalidation was lost (worker crash or a restore from an older snapshot), so the buyer keeps download access to a refunded material.",
    detectedBy: ["active_entitlement_without_purchase"],
    documents: {
      users: [creatorProfile, buyerProfile],
      materials: [material],
      purchases: [
        {
          _id: IDS.refundedPurchase,
          materialId: String(IDS.material),
          buyerAddress: BUYER.toLowerCase(),
          status: "refunded",
          transactionHash: TX_HASH,
          amount: "12.5",
          asset: "USDC",
          createdAt: daysAgo(20),
          updatedAt: daysAgo(2),
        },
      ],
      entitlement_cache: [
        {
          _id: IDS.orphanedEntitlement,
          buyerAddress: BUYER.toLowerCase(),
          materialId: String(IDS.material),
          active: true,
          source: "purchase",
          sourceVersion: String(daysAgo(20).getTime()),
          createdAt: daysAgo(20),
          updatedAt: daysAgo(20),
        },
      ],
    },
    repair: {
      kind: "script",
      command: "MONGODB_URI=<uri> MONGODB_DB=<db> node scripts/rebuild-entitlement-cache.mjs --repair",
      steps: [
        "Dry run first: DRY_RUN=true node scripts/rebuild-entitlement-cache.mjs --repair, and check that the planned delete is only this entitlement.",
        "Run the repair. The cache is rebuilt from completed purchases, so the entitlement with no confirmed/settled/completed purchase is deleted.",
        "The script re-diffs after repairing and exits 0 only when the cache matches the purchases.",
      ],
      expected: "The orphaned `entitlement_cache` row is gone; `active_entitlement_without_purchase` no longer reports it.",
    },
  },
  {
    id: "purchase-for-hard-deleted-material",
    title: "Confirmed purchase references a material that no longer exists",
    failure:
      "The material row was hard-deleted (manual cleanup or a partial restore) instead of soft-deleted, so the buyer's purchase points at nothing and entitlement-backed downloads cannot resolve the file.",
    detectedBy: ["purchases_missing_material"],
    documents: {
      users: [creatorProfile, buyerProfile],
      purchases: [
        {
          _id: IDS.orphanedPurchase,
          materialId: String(IDS.missingMaterial),
          buyerAddress: BUYER,
          status: "confirmed",
          transactionHash: TX_HASH,
          amount: "12.5",
          asset: "USDC",
          createdAt: daysAgo(30),
          updatedAt: daysAgo(30),
        },
      ],
    },
    repair: {
      kind: "manual",
      steps: [
        "Restore the material document from the most recent verified backup (docs/disaster-recovery.md; check it with `npm run verify:restore`).",
        "If no backup holds it, recover the title, storageKey/cid and creator from the audit ledger (`material.*` actions on the material id) and insert it as a soft-deleted tombstone: the original `_id`, a schema-valid document, plus the `buildSoftDeletePatch()` fields (src/lib/db/softDelete.js).",
        "Soft-deleted rows stay out of the public catalog, but the download path still resolves them for existing buyers.",
      ],
      expected: "A `materials` row exists for the purchase's materialId (live or `isDeleted: true`); `purchases_missing_material` no longer reports it.",
    },
  },
  {
    id: "duplicate-wallet-profiles",
    title: "Two profiles share one wallet address",
    failure:
      "Two concurrent first sign-ins (or a profile migration replay) each created a profile for the same wallet. Sessions can now resolve to either account.",
    detectedBy: ["duplicate_wallet_addresses"],
    documents: {
      users: [
        profile(IDS.duplicateProfileA, "fa11ed00-0000-4000-8000-000000000030", account("FIXTURETWIN"), daysAgo(40)),
        profile(IDS.duplicateProfileB, "fa11ed00-0000-4000-8000-000000000031", account("FIXTURETWIN"), daysAgo(39)),
      ],
    },
    repair: {
      kind: "manual",
      steps: [
        "Keep the oldest profile (earliest `createdAt`). Copy any fields that are set only on the newer one (email, displayName, bio) onto it.",
        "Re-point rows keyed by the newer profile's `_id` (refresh_tokens.userId, identity_links.userId) to the survivor. Wallet-keyed rows (purchases, saved_materials) need no change.",
        "Revoke the newer profile's sessions (revokeUserSessions with eventType `credentials_changed`), then delete it and record the merge in the audit ledger.",
      ],
      expected: "Exactly one profile per walletAddress; `duplicate_wallet_addresses` no longer reports it.",
    },
  },
  {
    id: "stale-dead-letter-event",
    title: "Indexer dead-letter event unresolved for over a week",
    failure:
      "A Soroban event failed to apply and exhausted its retries during an RPC outage. Nobody replayed it, so the off-chain projection is still missing that purchase or payout.",
    detectedBy: ["stale_dead_letter_events"],
    documents: {
      dead_letter_events: [
        {
          _id: IDS.deadLetter,
          raw: { id: IDS.deadLetter, type: "contract", ledger: 1, topic: ["purchase_completed"] },
          parsed: null,
          lastError: "Soroban RPC timeout while applying event",
          errorClass: "transient",
          retryCount: 5,
          lastAttemptedAt: daysAgo(10),
          status: "retryable",
          source: "stellar",
          createdAt: daysAgo(12),
        },
      ],
    },
    repair: {
      kind: "script",
      command: "node scripts/indexer-deadletter.mjs retry fa11ed-ledger-0000001-op-0001",
      steps: [
        "Inspect it: node scripts/indexer-deadletter.mjs list --status=retryable.",
        "Retry it once the RPC is healthy (command above), or reprocess every retryable or failed entry with node scripts/reprocess-deadletter.mjs.",
        "If it still cannot be applied, it is poison: node scripts/indexer-deadletter.mjs quarantine <eventId> --reason=\"...\" (docs/indexer-observability.md). It stops alerting but stays auditable in indexer_operator_audit.",
      ],
      expected: "The event is `resolved` (applied) or `quarantined`; `stale_dead_letter_events` no longer reports it.",
    },
  },
]);

/**
 * Generate copies of fixtures with every timestamp shifted so `FIXTURE_NOW`
 * becomes `now`. Ages ("pending for 3 days") are preserved, so the generated
 * state is detected the same way against a live clock. Ids are unchanged, so
 * load/unload stay idempotent. Does not mutate the catalog.
 */
export function generateFailureFixtures(fixtures, now = new Date()) {
  const offset = now.getTime() - FIXTURE_NOW.getTime();
  const shift = (value) => {
    if (value instanceof Date) return new Date(value.getTime() + offset);
    if (Array.isArray(value)) return value.map(shift);
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shift(inner)]));
    }
    return value;
  };
  return fixtures.map((fixture) => ({ ...fixture, documents: shift(fixture.documents) }));
}

export function getFailureFixture(id) {
  const fixture = FAILURE_FIXTURES.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Unknown failure fixture "${id}"`);
  return fixture;
}

/**
 * Idempotently load fixtures: every document is upserted by its fixed `_id`,
 * so re-running restores the exact failure state.
 * @returns {Promise<Record<string, number>>} documents written per collection
 */
export async function loadFailureFixtures(db, fixtures) {
  const written = {};
  for (const fixture of fixtures) {
    for (const [collection, documents] of Object.entries(fixture.documents)) {
      await db.collection(collection).bulkWrite(
        documents.map((document) => ({ replaceOne: { filter: { _id: document._id }, replacement: document, upsert: true } })),
        { ordered: true }
      );
      written[collection] = (written[collection] ?? 0) + documents.length;
    }
  }
  return written;
}

/** Remove every fixture document (all fixtures), leaving other data untouched. */
export async function unloadFailureFixtures(db) {
  const idsByCollection = new Map();
  for (const fixture of FAILURE_FIXTURES) {
    for (const [collection, documents] of Object.entries(fixture.documents)) {
      const ids = idsByCollection.get(collection) ?? new Map();
      for (const document of documents) ids.set(String(document._id), document._id);
      idsByCollection.set(collection, ids);
    }
  }
  const removed = {};
  for (const [collection, ids] of idsByCollection) {
    const result = await db.collection(collection).deleteMany({ _id: { $in: [...ids.values()] } });
    removed[collection] = result.deletedCount;
  }
  return removed;
}

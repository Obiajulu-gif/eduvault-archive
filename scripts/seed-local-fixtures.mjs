/**
 * seed-local-fixtures.mjs
 *
 * Deterministic, idempotent seed data for local development.
 *
 * Every document uses a stable `_id` derived from the fixture's logical key
 * (e.g. "creator:alice") so re-running is always safe: upserts replace stale
 * data without creating duplicates.
 *
 * Seeded collections:
 *   users            – 3 creators + 3 buyers
 *   materials         – 6 materials (2 per creator, varied price/visibility)
 *   purchases         – 3 completed purchases (one per buyer)
 *   entitlement_cache – 3 active entitlement entries derived from purchases
 *   refunds           – 2 refund records (one pending, one completed)
 *   analytics_events  – deterministic usage/failure/recovery/domain events
 *
 * Usage:
 *   node scripts/seed-local-fixtures.mjs
 *
 * Environment:
 *   MONGODB_URI  – defaults to mongodb://localhost:27017/eduvault
 *   MONGODB_DB   – defaults to eduvault
 *   FORCE_RESEED – set to "true" to drop and recreate all fixture documents
 *   SEED_ANCHOR  – ISO date used as "now" for deterministic trend fixtures
 */

import { MongoClient, ObjectId } from 'mongodb';

// ── helpers ───────────────────────────────────────────────────────────────────

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/eduvault';
const MONGODB_DB  = process.env.MONGODB_DB  ?? 'eduvault';
const FORCE       = process.env.FORCE_RESEED === 'true';
const SEED_ANCHOR = process.env.SEED_ANCHOR ?? '2024-06-01T00:00:00.000Z';

/**
 * Produce a deterministic ObjectId from an ASCII string seed.
 * Uses a simple djb2 hash padded to 12 bytes so the same logical key always
 * maps to the same _id — safe for upserts and cross-collection references.
 */
function deterministicId(seed) {
  let h = 5381n;
  for (const ch of seed) {
    h = ((h << 5n) + h + BigInt(ch.charCodeAt(0))) & 0xFFFFFFFFFFFFFFFFFFFFFFFFn;
  }
  // Produce a 12-byte hex string from the hash.
  const hex = h.toString(16).padStart(24, '0').slice(-24);
  return new ObjectId(hex);
}

const NOW = new Date(SEED_ANCHOR);
const DAY = 86_400_000;
const HOUR = 3_600_000;

function daysAgo(n) { return new Date(NOW - n * DAY); }
function daysFromNow(n) { return new Date(NOW.getTime() + n * DAY); }

function log(msg)  { console.log(`  [seed] ${msg}`); }
function ok(msg)   { console.log(`  [seed] ✓ ${msg}`); }
function warn(msg) { console.warn(`  [seed] ⚠ ${msg}`); }
function hoursAgo(n) { return new Date(NOW.getTime() - n * HOUR); }

// ── fixture definitions ───────────────────────────────────────────────────────

/** Deterministic local-dev wallet addresses (not real Stellar accounts). */
const WALLETS = {
  alice: 'GCREATOR_ALICE_LOCAL_000000000000000000000000000000000000000000',
  bob:   'GCREATOR_BOB_LOCAL_0000000000000000000000000000000000000000000000',
  carol: 'GCREATOR_CAROL_LOCAL_00000000000000000000000000000000000000000000',
  dave:  'GBUYER_DAVE_LOCAL_000000000000000000000000000000000000000000000000',
  eve:   'GBUYER_EVE_LOCAL_0000000000000000000000000000000000000000000000000',
  frank: 'GBUYER_FRANK_LOCAL_00000000000000000000000000000000000000000000000',
};

// Truncate/pad to a valid fixed length for display purposes.
Object.keys(WALLETS).forEach(k => {
  WALLETS[k] = (WALLETS[k] + '0'.repeat(56)).slice(0, 56);
});

const USERS = [
  {
    _id:              deterministicId('creator:alice'),
    fullName:         'Alice Creator',
    email:            'creator-alice@eduvault.local',
    walletAddress:    WALLETS.alice,
    walletAddressLower: WALLETS.alice.toLowerCase(),
    role:             'creator',
    bio:              'Soroban smart-contract educator. Seeded local fixture.',
    institution:      'EduVault Local',
    country:          'US',
    createdAt:        daysAgo(120),
    updatedAt:        daysAgo(1),
  },
  {
    _id:              deterministicId('creator:bob'),
    fullName:         'Bob Creator',
    email:            'creator-bob@eduvault.local',
    walletAddress:    WALLETS.bob,
    walletAddressLower: WALLETS.bob.toLowerCase(),
    role:             'creator',
    bio:              'Stellar DeFi course author. Seeded local fixture.',
    institution:      'EduVault Local',
    country:          'GB',
    createdAt:        daysAgo(90),
    updatedAt:        daysAgo(2),
  },
  {
    _id:              deterministicId('creator:carol'),
    fullName:         'Carol Creator',
    email:            'creator-carol@eduvault.local',
    walletAddress:    WALLETS.carol,
    walletAddressLower: WALLETS.carol.toLowerCase(),
    role:             'creator',
    bio:              'Blockchain security researcher. Seeded local fixture.',
    institution:      'EduVault Local',
    country:          'CA',
    createdAt:        daysAgo(60),
    updatedAt:        daysAgo(3),
  },
  {
    _id:              deterministicId('buyer:dave'),
    fullName:         'Dave Buyer',
    email:            'buyer-dave@eduvault.local',
    walletAddress:    WALLETS.dave,
    walletAddressLower: WALLETS.dave.toLowerCase(),
    role:             'buyer',
    createdAt:        daysAgo(30),
    updatedAt:        daysAgo(0),
  },
  {
    _id:              deterministicId('buyer:eve'),
    fullName:         'Eve Buyer',
    email:            'buyer-eve@eduvault.local',
    walletAddress:    WALLETS.eve,
    walletAddressLower: WALLETS.eve.toLowerCase(),
    role:             'buyer',
    createdAt:        daysAgo(25),
    updatedAt:        daysAgo(0),
  },
  {
    _id:              deterministicId('buyer:frank'),
    fullName:         'Frank Buyer',
    email:            'buyer-frank@eduvault.local',
    walletAddress:    WALLETS.frank,
    walletAddressLower: WALLETS.frank.toLowerCase(),
    role:             'buyer',
    createdAt:        daysAgo(20),
    updatedAt:        daysAgo(0),
  },
];

const MATERIALS = [
  {
    _id:          deterministicId('material:alice:intro-soroban'),
    userAddress:  WALLETS.alice,
    title:        'Introduction to Soroban Smart Contracts',
    description:  'A beginner-friendly guide to writing and deploying Soroban contracts on Stellar.',
    price:        10,
    visibility:   'public',
    storageKey:   'bafybeialiceintrosoroban000000000000000000000000000000000000000',
    materialId:   'MATID_ALICE_001_LOCAL_0000000000000000000000000000000000',
    syncStatus:   'synced',
    shortSummary: 'Learn Soroban from scratch.',
    learningOutcomes: ['Understand Soroban storage', 'Write a basic contract', 'Deploy to testnet'],
    createdAt:    daysAgo(100),
    updatedAt:    daysAgo(5),
  },
  {
    _id:          deterministicId('material:alice:advanced-soroban'),
    userAddress:  WALLETS.alice,
    title:        'Advanced Soroban: TTL, Events, and Cross-Contract Calls',
    description:  'Deep-dive into TTL management, event schemas, and cross-contract invocations.',
    price:        25,
    visibility:   'public',
    storageKey:   'bafybeialiceadvancedsoroban00000000000000000000000000000000000',
    materialId:   'MATID_ALICE_002_LOCAL_0000000000000000000000000000000000',
    syncStatus:   'synced',
    shortSummary: 'Master advanced Soroban patterns.',
    learningOutcomes: ['TTL renewal strategies', 'Event-driven indexing', 'Cross-contract patterns'],
    createdAt:    daysAgo(80),
    updatedAt:    daysAgo(4),
  },
  {
    _id:          deterministicId('material:bob:stellar-defi'),
    userAddress:  WALLETS.bob,
    title:        'Stellar DeFi: AMMs and Liquidity Pools',
    description:  'How Automated Market Makers work on Stellar and how to build one.',
    price:        20,
    visibility:   'public',
    storageKey:   'bafybeibobstellardefi0000000000000000000000000000000000000000',
    materialId:   'MATID_BOB_001_LOCAL_00000000000000000000000000000000000',
    syncStatus:   'synced',
    shortSummary: 'Build AMMs on Stellar.',
    learningOutcomes: ['AMM mathematics', 'Stellar DEX integration', 'Liquidity provision'],
    createdAt:    daysAgo(75),
    updatedAt:    daysAgo(3),
  },
  {
    _id:          deterministicId('material:bob:xlm-payments'),
    userAddress:  WALLETS.bob,
    title:        'XLM Payments and Escrow Patterns',
    description:  'Implement payment flows and escrow custody with Stellar and Soroban.',
    price:        15,
    visibility:   'unlisted',
    storageKey:   'bafybeibobxlmpayments000000000000000000000000000000000000000',
    materialId:   'MATID_BOB_002_LOCAL_00000000000000000000000000000000000',
    syncStatus:   'synced',
    shortSummary: 'Escrow and payment patterns.',
    learningOutcomes: ['Stellar payment operations', 'Escrow state machines', 'Dispute resolution'],
    createdAt:    daysAgo(50),
    updatedAt:    daysAgo(2),
  },
  {
    _id:          deterministicId('material:carol:blockchain-security'),
    userAddress:  WALLETS.carol,
    title:        'Blockchain Security: Smart Contract Auditing',
    description:  'Common vulnerability patterns in Soroban contracts and how to prevent them.',
    price:        30,
    visibility:   'public',
    storageKey:   'bafybeicapolsecurity000000000000000000000000000000000000000',
    materialId:   'MATID_CAROL_001_LOCAL_000000000000000000000000000000000',
    syncStatus:   'synced',
    shortSummary: 'Audit Soroban contracts.',
    learningOutcomes: ['Vulnerability classification', 'Audit methodology', 'Fix patterns'],
    createdAt:    daysAgo(45),
    updatedAt:    daysAgo(1),
  },
  {
    _id:          deterministicId('material:carol:private-draft'),
    userAddress:  WALLETS.carol,
    title:        'Zero-Knowledge Proofs on Stellar (Draft)',
    description:  'Work-in-progress notes on ZK integration with Stellar. Not yet published.',
    price:        0,
    visibility:   'private',
    storageKey:   'bafybeicapolzkdraft000000000000000000000000000000000000000',
    materialId:   null,
    syncStatus:   'pending',
    shortSummary: 'Draft ZK notes.',
    createdAt:    daysAgo(10),
    updatedAt:    daysAgo(0),
  },
];

/** Purchase IDs — deterministic strings matching what an indexer would assign. */
const PURCHASE_IDS = {
  dave:  'PURCHASE_DAVE_001_LOCAL_000000000000000000000000000000000000000',
  eve:   'PURCHASE_EVE_001_LOCAL_0000000000000000000000000000000000000000',
  frank: 'PURCHASE_FRANK_001_LOCAL_00000000000000000000000000000000000000',
};

const PURCHASES = [
  {
    _id:           deterministicId('purchase:dave:alice-intro'),
    materialId:    MATERIALS[0].materialId,
    buyerAddress:  WALLETS.dave,
    sellerAddress: WALLETS.alice,
    status:        'confirmed',
    chainTxHash:   'TXHASH_DAVE_ALICE_INTRO_LOCAL_0000000000000000000000000000000',
    amount:        10_000_000,       // 10 USDC in 7-decimal minor units
    asset:         'USDC_LOCAL_ASSET_CONTRACT_ID_00000000000000000000000000000',
    purchaseId:    PURCHASE_IDS.dave,
    purchaseSnapshot: {
      metadataHash:      'HASH_ALICE_INTRO_META_000000000000000000000000000000000000',
      rightsHash:        'HASH_ALICE_INTRO_RIGHTS_00000000000000000000000000000000000',
      saleTermsVersion:  1,
      purchaseLedger:    1_000_000,
    },
    createdAt:     daysAgo(20),
    updatedAt:     daysAgo(20),
  },
  {
    _id:           deterministicId('purchase:eve:bob-defi'),
    materialId:    MATERIALS[2].materialId,
    buyerAddress:  WALLETS.eve,
    sellerAddress: WALLETS.bob,
    status:        'confirmed',
    chainTxHash:   'TXHASH_EVE_BOB_DEFI_LOCAL_000000000000000000000000000000000',
    amount:        20_000_000,
    asset:         'USDC_LOCAL_ASSET_CONTRACT_ID_00000000000000000000000000000',
    purchaseId:    PURCHASE_IDS.eve,
    purchaseSnapshot: {
      metadataHash:     'HASH_BOB_DEFI_META_0000000000000000000000000000000000000',
      rightsHash:       'HASH_BOB_DEFI_RIGHTS_000000000000000000000000000000000000',
      saleTermsVersion: 1,
      purchaseLedger:   1_050_000,
    },
    createdAt:     daysAgo(15),
    updatedAt:     daysAgo(15),
  },
  {
    _id:           deterministicId('purchase:frank:carol-security'),
    materialId:    MATERIALS[4].materialId,
    buyerAddress:  WALLETS.frank,
    sellerAddress: WALLETS.carol,
    status:        'confirmed',
    chainTxHash:   'TXHASH_FRANK_CAROL_SEC_LOCAL_00000000000000000000000000000000',
    amount:        30_000_000,
    asset:         'USDC_LOCAL_ASSET_CONTRACT_ID_00000000000000000000000000000',
    purchaseId:    PURCHASE_IDS.frank,
    purchaseSnapshot: {
      metadataHash:     'HASH_CAROL_SEC_META_000000000000000000000000000000000000',
      rightsHash:       'HASH_CAROL_SEC_RIGHTS_00000000000000000000000000000000000',
      saleTermsVersion: 1,
      purchaseLedger:   1_100_000,
    },
    createdAt:     daysAgo(10),
    updatedAt:     daysAgo(10),
  },
];

const ENTITLEMENTS = PURCHASES.map((p) => ({
  _id:          deterministicId(`entitlement:${p.buyerAddress}:${p.materialId}`),
  materialId:   p.materialId,
  buyerAddress: p.buyerAddress,
  active:       true,
  source:       'soroban',
  purchaseId:   p.purchaseId,
  createdAt:    p.createdAt,
  updatedAt:    p.updatedAt,
}));

const REFUNDS = [
  {
    _id:          deterministicId('refund:eve:bob-defi:pending'),
    purchaseId:   PURCHASE_IDS.eve,
    materialId:   MATERIALS[2].materialId,
    buyerAddress: WALLETS.eve,
    sellerAddress:WALLETS.bob,
    status:       'pending',              // refund requested, not yet on-chain
    requestedAt:  daysAgo(2),
    amount:       19_000_000,             // seller_net after 5 % platform fee
    asset:        'USDC_LOCAL_ASSET_CONTRACT_ID_00000000000000000000000000000',
    reason:       'Content did not match description',
    createdAt:    daysAgo(2),
    updatedAt:    daysAgo(2),
  },
  {
    _id:          deterministicId('refund:dave:alice-intro:completed'),
    purchaseId:   deterministicId('purchase:dave:alice-intro-refunded').toHexString(),
    materialId:   MATERIALS[0].materialId,
    buyerAddress: WALLETS.dave,
    sellerAddress:WALLETS.alice,
    status:       'completed',
    requestedAt:  daysAgo(5),
    completedAt:  daysAgo(4),
    amount:       9_500_000,
    asset:        'USDC_LOCAL_ASSET_CONTRACT_ID_00000000000000000000000000000',
    reason:       'Test refund — completed scenario',
    chainTxHash:  'TXHASH_DAVE_REFUND_COMPLETED_LOCAL_000000000000000000000000',
    createdAt:    daysAgo(5),
    updatedAt:    daysAgo(4),
  },
];

/**
 * Deterministic analytics events used to exercise historical trend
 * aggregation. Each event carries:
 *   - type:     usage | failure | recovery | domain
 *   - metric:   stable metric key the aggregator groups by
 *   - window:   coarse bucket hint (day) for deterministic rollups
 *   - actor:    wallet address (redacted in exports, kept for local dev)
 *   - subject:  materialId or purchaseId the event pertains to
 *   - value:    numeric contribution (counts, durations, amounts)
 *   - private:  true when the event must be redacted in exported reports
 */
const EVENT_TYPES = ['usage', 'failure', 'recovery', 'domain'];

function makeEvent(key, { type, metric, daysBack, actor, subject, value, private: isPrivate = false }) {
  const occurredAt = daysAgo(daysBack);
  return {
    _id:        deterministicId(`event:${key}`),
    type,
    metric,
    actor,
    subject,
    value,
    private:    isPrivate,
    occurredAt,
    window:     occurredAt.toISOString().slice(0, 10),
    createdAt:  occurredAt,
    updatedAt:  occurredAt,
  };
}

const ANALYTICS_EVENTS = [
  // ── usage: material views across the last 30 days ─────────────────────────
  makeEvent('usage:alice-intro:d-1',  { type: 'usage', metric: 'material.view', daysBack: 1,  actor: WALLETS.dave,  subject: MATERIALS[0].materialId, value: 12 }),
  makeEvent('usage:alice-intro:d-5',  { type: 'usage', metric: 'material.view', daysBack: 5,  actor: WALLETS.eve,   subject: MATERIALS[0].materialId, value: 8 }),
  makeEvent('usage:alice-intro:d-12', { type: 'usage', metric: 'material.view', daysBack: 12, actor: WALLETS.frank, subject: MATERIALS[0].materialId, value: 5 }),
  makeEvent('usage:bob-defi:d-2',     { type: 'usage', metric: 'material.view', daysBack: 2,  actor: WALLETS.dave,  subject: MATERIALS[2].materialId, value: 9 }),
  makeEvent('usage:bob-defi:d-9',     { type: 'usage', metric: 'material.view', daysBack: 9,  actor: WALLETS.eve,   subject: MATERIALS[2].materialId, value: 4 }),
  makeEvent('usage:carol-sec:d-3',    { type: 'usage', metric: 'material.view', daysBack: 3,  actor: WALLETS.frank, subject: MATERIALS[4].materialId, value: 7 }),
  makeEvent('usage:carol-sec:d-20',   { type: 'usage', metric: 'material.view', daysBack: 20, actor: WALLETS.dave,  subject: MATERIALS[4].materialId, value: 3 }),

  // ── usage: storage sync operations ────────────────────────────────────────
  makeEvent('usage:sync:alice:d-1',   { type: 'usage', metric: 'storage.sync',   daysBack: 1,  actor: WALLETS.alice, subject: MATERIALS[0].materialId, value: 1 }),
  makeEvent('usage:sync:bob:d-4',     { type: 'usage', metric: 'storage.sync',   daysBack: 4,  actor: WALLETS.bob,   subject: MATERIALS[2].materialId, value: 1 }),
  makeEvent('usage:sync:carol:d-10',  { type: 'usage', metric: 'storage.sync',   daysBack: 10, actor: WALLETS.carol, subject: MATERIALS[4].materialId, value: 1 }),

  // ── failure: storage / entitlement failures ───────────────────────────────
  makeEvent('failure:sync:carol:d-0', { type: 'failure', metric: 'storage.sync.failed', daysBack: 0,  actor: WALLETS.carol, subject: MATERIALS[5].materialId, value: 1 }),
  makeEvent('failure:sync:carol:d-6', { type: 'failure', metric: 'storage.sync.failed', daysBack: 6,  actor: WALLETS.carol, subject: MATERIALS[5].materialId, value: 1 }),
  makeEvent('failure:ent:d-3',        { type: 'failure', metric: 'entitlement.miss',    daysBack: 3,  actor: WALLETS.eve,   subject: MATERIALS[2].materialId, value: 1 }),
  makeEvent('failure:ent:d-14',       { type: 'failure', metric: 'entitlement.miss',    daysBack: 14, actor: WALLETS.dave,  subject: MATERIALS[0].materialId, value: 1 }),

  // ── recovery: retries and refund completions ──────────────────────────────
  makeEvent('recovery:sync:carol:d-0', { type: 'recovery', metric: 'storage.sync.retried', daysBack: 0, actor: WALLETS.carol, subject: MATERIALS[5].materialId, value: 1 }),
  makeEvent('recovery:sync:carol:d-6', { type: 'recovery', metric: 'storage.sync.retried', daysBack: 6, actor: WALLETS.carol, subject: MATERIALS[5].materialId, value: 1 }),
  makeEvent('recovery:refund:d-4',     { type: 'recovery', metric: 'refund.completed',     daysBack: 4, actor: WALLETS.dave,  subject: MATERIALS[0].materialId, value: 9_500_000 }),

  // ── domain: purchases, refunds, marketplace activity ──────────────────────
  makeEvent('domain:purchase:dave:d-20',  { type: 'domain', metric: 'purchase.confirmed', daysBack: 20, actor: WALLETS.dave,  subject: MATERIALS[0].materialId, value: 10_000_000 }),
  makeEvent('domain:purchase:eve:d-15',   { type: 'domain', metric: 'purchase.confirmed', daysBack: 15, actor: WALLETS.eve,   subject: MATERIALS[2].materialId, value: 20_000_000 }),
  makeEvent('domain:purchase:frank:d-10', { type: 'domain', metric: 'purchase.confirmed', daysBack: 10, actor: WALLETS.frank, subject: MATERIALS[4].materialId, value: 30_000_000 }),
  makeEvent('domain:refund:eve:d-2',      { type: 'domain', metric: 'refund.requested',   daysBack: 2,  actor: WALLETS.eve,   subject: MATERIALS[2].materialId, value: 19_000_000 }),
  makeEvent('domain:refund:dave:d-5',     { type: 'domain', metric: 'refund.requested',   daysBack: 5,  actor: WALLETS.dave,  subject: MATERIALS[0].materialId, value: 9_500_000 }),

  // ── private: must be redacted in exported reports ─────────────────────────
  makeEvent('private:carol-draft:view:d-1', { type: 'usage', metric: 'material.view', daysBack: 1, actor: WALLETS.carol, subject: MATERIALS[5].materialId, value: 2, private: true }),
  makeEvent('private:carol-draft:edit:d-0', { type: 'usage', metric: 'material.edit', daysBack: 0, actor: WALLETS.carol, subject: MATERIALS[5].materialId, value: 1, private: true }),
];

/**
 * Trend aggregation windows. Each window defines a deterministic bucket
 * size (in days) and the number of buckets to emit, ending at NOW.
 */
const TREND_WINDOWS = [
  { name: 'daily',   bucketDays: 1,  buckets: 30 },
  { name: 'weekly',  bucketDays: 7,  buckets: 12 },
  { name: 'monthly', bucketDays: 30, buckets: 6  },
];

/**
 * Deterministic aggregation over ANALYTICS_EVENTS for a given window.
 * Returns a report shape with a schema version so downstream consumers can
 * evolve safely. Private events are aggregated into a redacted bucket.
 */
function aggregateTrends(events, window) {
  const { name, bucketDays, buckets } = window;
  const bucketMs = bucketDays * DAY;
  const endMs = NOW.getTime();
  const startMs = endMs - buckets * bucketMs;

  const series = Array.from({ length: buckets }, (_, i) => ({
    bucketStart: new Date(startMs + i * bucketMs).toISOString(),
    bucketEnd:   new Date(startMs + (i + 1) * bucketMs).toISOString(),
    totals:      { usage: 0, failure: 0, recovery: 0, domain: 0 },
    redacted:    0,
  }));

  for (const ev of events) {
    const t = ev.occurredAt.getTime();
    if (t < startMs || t >= endMs) continue;
    const idx = Math.min(buckets - 1, Math.floor((t - startMs) / bucketMs));
    const bucket = series[idx];
    if (ev.private) {
      bucket.redacted += 1;
      continue;
    }
    if (EVENT_TYPES.includes(ev.type)) {
      bucket.totals[ev.type] += ev.value;
    }
  }

  return {
    schemaVersion: 1,
    window:        name,
    bucketDays,
    generatedAt:   NOW.toISOString(),
    series,
  };
}

// ── seeding logic ─────────────────────────────────────────────────────────────

async function upsertAll(collection, docs, labelFn) {
  let inserted = 0;
  let updated  = 0;

  for (const doc of docs) {
    const result = await collection.replaceOne(
      { _id: doc._id },
      doc,
      { upsert: true },
    );
    if (result.upsertedCount > 0) inserted++;
    else if (result.modifiedCount > 0) updated++;
  }

  return { inserted, updated };
}

async function main() {
  const client = new MongoClient(MONGODB_URI);

  try {
    log(`Connecting to ${MONGODB_URI} …`);
    await client.connect();
    const db = client.db(MONGODB_DB);
    log(`Connected to database "${MONGODB_DB}"`);

    if (FORCE) {
      warn('FORCE_RESEED=true — deleting existing fixture documents …');
      const ids = [
        ...USERS.map(d => d._id),
        ...MATERIALS.map(d => d._id),
        ...PURCHASES.map(d => d._id),
        ...ENTITLEMENTS.map(d => d._id),
        ...REFUNDS.map(d => d._id),
        ...ANALYTICS_EVENTS.map(d => d._id),
      ];
      await db.collection('users').deleteMany({ _id: { $in: ids } });
      await db.collection('materials').deleteMany({ _id: { $in: ids } });
      await db.collection('purchases').deleteMany({ _id: { $in: ids } });
      await db.collection('entitlement_cache').deleteMany({ _id: { $in: ids } });
      await db.collection('refunds').deleteMany({ _id: { $in: ids } });
      await db.collection('analytics_events').deleteMany({ _id: { $in: ids } });
      warn('Existing fixture documents cleared.');
    }

    log('Seeding users (3 creators + 3 buyers) …');
    const userResult = await upsertAll(db.collection('users'), USERS);
    ok(`users: ${userResult.inserted} inserted, ${userResult.updated} updated`);

    log('Seeding materials (6 total) …');
    const matResult = await upsertAll(db.collection('materials'), MATERIALS);
    ok(`materials: ${matResult.inserted} inserted, ${matResult.updated} updated`);

    log('Seeding purchases (3 confirmed) …');
    const purResult = await upsertAll(db.collection('purchases'), PURCHASES);
    ok(`purchases: ${purResult.inserted} inserted, ${purResult.updated} updated`);

    log('Seeding entitlement_cache (3 active) …');
    const entResult = await upsertAll(db.collection('entitlement_cache'), ENTITLEMENTS);
    ok(`entitlement_cache: ${entResult.inserted} inserted, ${entResult.updated} updated`);

    log('Seeding refunds (1 pending + 1 completed) …');
    const refResult = await upsertAll(db.collection('refunds'), REFUNDS);
    ok(`refunds: ${refResult.inserted} inserted, ${refResult.updated} updated`);

    log(`Seeding analytics_events (${ANALYTICS_EVENTS.length} deterministic events) …`);
    const evtResult = await upsertAll(db.collection('analytics_events'), ANALYTICS_EVENTS);
    ok(`analytics_events: ${evtResult.inserted} inserted, ${evtResult.updated} updated`);

    // Print counts for quick verification.
    const counts = {
      users:             await db.collection('users').countDocuments(),
      materials:         await db.collection('materials').countDocuments(),
      purchases:         await db.collection('purchases').countDocuments(),
      entitlement_cache: await db.collection('entitlement_cache').countDocuments(),
      refunds:           await db.collection('refunds').countDocuments(),
      analytics_events:  await db.collection('analytics_events').countDocuments(),
    };

    log('Collection totals after seed:');
    Object.entries(counts).forEach(([col, n]) => log(`  ${col}: ${n} documents`));

    // Emit deterministic trend reports for each configured window so that
    // maintainer analytics can be validated against fixture data.
    log('Computing deterministic trend aggregations …');
    for (const window of TREND_WINDOWS) {
      const report = aggregateTrends(ANALYTICS_EVENTS, window);
      const total = report.series.reduce(
        (acc, b) => acc + Object.values(b.totals).reduce((a, v) => a + v, 0),
        0,
      );
      ok(`trend[${window.name}] schemaVersion=${report.schemaVersion} buckets=${report.series.length} total=${total}`);
    }

    ok('Fixture seeding complete.');
  } catch (err) {
    console.error(`[seed] ERROR: ${err.message}`);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();

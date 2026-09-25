/**
 * smoke-local.mjs
 *
 * Local development smoke test run after bootstrap-local.sh.
 * Verifies the seeded fixture data is queryable and internally consistent
 * without requiring a running Next.js server or real Stellar network access.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 *
 * Usage:
 *   node scripts/smoke-local.mjs
 */

import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/eduvault';
const MONGODB_DB  = process.env.MONGODB_DB  ?? 'eduvault';

let failures = 0;

function pass(label) { console.log(`  [smoke] ✓  ${label}`); }
function fail(label, detail) {
  console.error(`  [smoke] ✗  FAIL: ${label}`);
  if (detail) console.error(`             ${detail}`);
  failures++;
}
function section(title) {
  console.log(`\n  [smoke] ── ${title}`);
}

async function main() {
  console.log('\n  [smoke] Local smoke test starting …');

  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);

    // ── 1. Users ────────────────────────────────────────────────────────────
    section('Users');

    const users = await db.collection('users').find({
      email: { $regex: '@eduvault\\.local$' },
    }).toArray();

    const creators = users.filter(u => u.role === 'creator');
    const buyers   = users.filter(u => u.role === 'buyer');

    creators.length >= 3
      ? pass(`${creators.length} creator accounts present`)
      : fail('Expected ≥ 3 creators', `found ${creators.length}`);

    buyers.length >= 3
      ? pass(`${buyers.length} buyer accounts present`)
      : fail('Expected ≥ 3 buyers', `found ${buyers.length}`);

    const allHaveWallet = users.every(u => u.walletAddress && u.walletAddress.length > 0);
    allHaveWallet
      ? pass('All users have walletAddress set')
      : fail('One or more users missing walletAddress');

    const emailsUnique = new Set(users.map(u => u.email)).size === users.length;
    emailsUnique
      ? pass('User emails are unique')
      : fail('Duplicate email detected among fixture users');

    // ── 2. Materials ────────────────────────────────────────────────────────
    section('Materials');

    const materials = await db.collection('materials').find({
      userAddress: { $regex: '^GCREATOR_.*_LOCAL' },
    }).toArray();

    materials.length >= 6
      ? pass(`${materials.length} materials present`)
      : fail('Expected ≥ 6 materials', `found ${materials.length}`);

    const publicMats = materials.filter(m => m.visibility === 'public');
    publicMats.length >= 4
      ? pass(`${publicMats.length} public materials`)
      : fail('Expected ≥ 4 public materials', `found ${publicMats.length}`);

    const privateMats = materials.filter(m => m.visibility === 'private');
    privateMats.length >= 1
      ? pass(`${privateMats.length} private material(s) present`)
      : fail('Expected ≥ 1 private material');

    const syncedMats = materials.filter(m => m.syncStatus === 'synced');
    syncedMats.length >= 4
      ? pass(`${syncedMats.length} materials with syncStatus=synced`)
      : fail('Expected ≥ 4 synced materials', `found ${syncedMats.length}`);

    const allHaveTitle = materials.every(m => m.title && m.title.length > 0);
    allHaveTitle
      ? pass('All materials have titles')
      : fail('One or more materials missing title');

    const allHavePrice = materials.every(m => typeof m.price === 'number' && m.price >= 0);
    allHavePrice
      ? pass('All materials have non-negative price')
      : fail('One or more materials have invalid price');

    // ── 3. Purchases ────────────────────────────────────────────────────────
    section('Purchases');

    const purchases = await db.collection('purchases').find({
      buyerAddress: { $regex: '^GBUYER_.*_LOCAL' },
    }).toArray();

    purchases.length >= 3
      ? pass(`${purchases.length} purchase records present`)
      : fail('Expected ≥ 3 purchases', `found ${purchases.length}`);

    const confirmedPurchases = purchases.filter(p => p.status === 'confirmed');
    confirmedPurchases.length >= 3
      ? pass(`${confirmedPurchases.length} confirmed purchases`)
      : fail('Expected ≥ 3 confirmed purchases', `found ${confirmedPurchases.length}`);

    const allHaveSnapshot = purchases.every(p => p.purchaseSnapshot?.metadataHash);
    allHaveSnapshot
      ? pass('All purchases carry a purchaseSnapshot with metadataHash')
      : fail('One or more purchases missing purchaseSnapshot.metadataHash');

    const allHaveAmount = purchases.every(p => typeof p.amount === 'number' && p.amount > 0);
    allHaveAmount
      ? pass('All purchases have positive amount')
      : fail('One or more purchases have zero or missing amount');

    // ── 4. Entitlements ─────────────────────────────────────────────────────
    section('Entitlement cache');

    const entitlements = await db.collection('entitlement_cache').find({
      buyerAddress: { $regex: '^GBUYER_.*_LOCAL' },
    }).toArray();

    entitlements.length >= 3
      ? pass(`${entitlements.length} entitlement cache entries present`)
      : fail('Expected ≥ 3 entitlement cache entries', `found ${entitlements.length}`);

    const allActive = entitlements.every(e => e.active === true);
    allActive
      ? pass('All entitlement cache entries are active')
      : fail('One or more entitlement entries are not active');

    const allFromSoroban = entitlements.every(e => e.source === 'soroban');
    allFromSoroban
      ? pass("All entitlement entries have source='soroban'")
      : fail("Expected all entitlement entries to have source='soroban'");

    // Cross-check: every purchase buyer+material pair has an entitlement entry.
    for (const p of purchases) {
      const matched = entitlements.find(
        e => e.buyerAddress === p.buyerAddress && e.materialId === p.materialId,
      );
      matched
        ? pass(`Entitlement exists for buyer ${p.buyerAddress.slice(0, 12)}… × material ${p.materialId?.slice(0, 12) ?? 'n/a'}…`)
        : fail(`Missing entitlement for buyer ${p.buyerAddress.slice(0, 12)}… × material ${p.materialId?.slice(0, 12) ?? 'n/a'}…`);
    }

    // ── 5. Refunds ──────────────────────────────────────────────────────────
    section('Refunds');

    const refunds = await db.collection('refunds').find({
      buyerAddress: { $regex: '^GBUYER_.*_LOCAL' },
    }).toArray();

    refunds.length >= 2
      ? pass(`${refunds.length} refund records present`)
      : fail('Expected ≥ 2 refund records', `found ${refunds.length}`);

    const pendingRefunds   = refunds.filter(r => r.status === 'pending');
    const completedRefunds = refunds.filter(r => r.status === 'completed');

    pendingRefunds.length >= 1
      ? pass(`${pendingRefunds.length} pending refund(s)`)
      : fail('Expected ≥ 1 pending refund');

    completedRefunds.length >= 1
      ? pass(`${completedRefunds.length} completed refund(s)`)
      : fail('Expected ≥ 1 completed refund');

    const allRefundsPositive = refunds.every(r => r.amount > 0);
    allRefundsPositive
      ? pass('All refund amounts are positive')
      : fail('One or more refunds have zero or negative amount');

    // ── 6. Referential integrity: materials ↔ purchases ────────────────────
    section('Referential integrity');

    for (const p of purchases) {
      if (!p.materialId) continue;
      const mat = materials.find(m => m.materialId === p.materialId);
      mat
        ? pass(`Purchase references valid material ${p.materialId.slice(0, 18)}…`)
        : fail(`Purchase references unknown materialId ${p.materialId.slice(0, 18)}…`);
    }

    // ── 7. Collection counts are deterministic ──────────────────────────────
    section('Determinism check');

    const localUsers  = await db.collection('users').countDocuments({ email: { $regex: '@eduvault\\.local$' } });
    const localMats   = await db.collection('materials').countDocuments({ userAddress: { $regex: '^GCREATOR_.*_LOCAL' } });
    const localPurch  = await db.collection('purchases').countDocuments({ buyerAddress: { $regex: '^GBUYER_.*_LOCAL' } });
    const localEnt    = await db.collection('entitlement_cache').countDocuments({ buyerAddress: { $regex: '^GBUYER_.*_LOCAL' } });
    const localRefund = await db.collection('refunds').countDocuments({ buyerAddress: { $regex: '^GBUYER_.*_LOCAL' } });

    const expected = { users: 6, materials: 6, purchases: 3, entitlement_cache: 3, refunds: 2 };
    const actual   = { users: localUsers, materials: localMats, purchases: localPurch, entitlement_cache: localEnt, refunds: localRefund };

    for (const [col, exp] of Object.entries(expected)) {
      actual[col] === exp
        ? pass(`${col}: exactly ${exp} fixture document(s)`)
        : fail(`${col}: expected ${exp}, found ${actual[col]}`);
    }

  } catch (err) {
    fail('MongoDB connection or query error', err.message);
  } finally {
    await client.close();
  }

  // ── summary ────────────────────────────────────────────────────────────────
  console.log('');
  if (failures === 0) {
    console.log('  [smoke] ✓  All checks passed.\n');
    process.exit(0);
  } else {
    console.error(`  [smoke] ✗  ${failures} check(s) failed.\n`);
    process.exit(1);
  }
}

main();

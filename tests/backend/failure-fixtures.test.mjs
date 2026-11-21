/**
 * Rare failure-mode fixtures and repair paths (#881).
 *
 * Proves every fixture still matches the current schemas and integrity rules,
 * loads idempotently, and that its repair path clears it.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Double, MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';

import {
  FAILURE_FIXTURES,
  FIXTURE_NOW,
  generateFailureFixtures,
  getFailureFixture,
  loadFailureFixtures,
  unloadFailureFixtures,
} from '../../scripts/lib/failure-fixtures.mjs';
import { INTEGRITY_CONSTRAINTS, validateIntegrity } from '../../scripts/lib/integrity-rules.mjs';
import { MaterialSchema } from '../../src/lib/db/schemas/material.js';
import { ProfileSchema } from '../../src/lib/db/schemas/profile.js';
import { buildSoftDeletePatch } from '../../src/lib/db/softDelete.js';
import { reconcilePendingPurchases } from '../../src/lib/purchases/paymentReconciler.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const DB_NAME = 'failure_fixtures_test';

let mongod;
let client;
let db;

/** Collections with a `$jsonSchema` validator, created exactly as in production. */
async function createValidatedCollections() {
  for (const [name, schema] of [['users', ProfileSchema], ['materials', MaterialSchema]]) {
    await db.createCollection(name, { validator: schema.validator, validationLevel: 'strict', validationAction: 'error' });
  }
}

async function detectedRules() {
  const results = await validateIntegrity(db, { now: FIXTURE_NOW, logger: () => {} });
  return results.violations.map((violation) => violation.id).sort();
}

function runScript(script, args, env = {}) {
  return run(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: { ...process.env, MONGODB_URI: mongod.getUri(), MONGODB_DB: DB_NAME, ...env },
  });
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db(DB_NAME);
});

after(async () => {
  await client.close();
  await mongod.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await createValidatedCollections();
});

describe('fixture catalog', () => {
  const ruleIds = new Set(INTEGRITY_CONSTRAINTS.map((rule) => rule.id));

  it('declares unique fixtures with existing detectors and complete repair paths', () => {
    assert.equal(new Set(FAILURE_FIXTURES.map((f) => f.id)).size, FAILURE_FIXTURES.length);
    for (const fixture of FAILURE_FIXTURES) {
      assert.ok(fixture.detectedBy.length > 0, fixture.id);
      for (const rule of fixture.detectedBy) assert.ok(ruleIds.has(rule), `${fixture.id}: unknown rule ${rule}`);
      assert.ok(['automated', 'script', 'manual'].includes(fixture.repair.kind), fixture.id);
      assert.ok(fixture.repair.steps.length > 0 && fixture.repair.expected, fixture.id);
      if (fixture.repair.kind !== 'manual') assert.ok(fixture.repair.command, `${fixture.id}: missing command`);
    }
  });

  it('uses recognisable ids and identical shared documents across fixtures', () => {
    const seen = new Map();
    for (const fixture of FAILURE_FIXTURES) {
      for (const [collection, documents] of Object.entries(fixture.documents)) {
        for (const document of documents) {
          assert.match(String(document._id), /^fa11ed/, `${fixture.id}: ${collection} id`);
          const key = `${collection}:${document._id}`;
          if (seen.has(key)) assert.ok(isDeepStrictEqual(seen.get(key), document), `${key} differs between fixtures`);
          seen.set(key, document);
        }
      }
    }
  });
});

describe('fixture validity', () => {
  it('rejects schema-invalid documents (validators are active)', async () => {
    await assert.rejects(db.collection('materials').insertOne({ title: 'missing required fields' }), { code: 121 });
  });

  it('loads every fixture into schema-validated collections', async () => {
    const written = await loadFailureFixtures(db, FAILURE_FIXTURES);
    assert.ok(written.users > 0 && written.materials > 0);
  });

  for (const fixture of FAILURE_FIXTURES) {
    it(`${fixture.id} is detected by exactly ${fixture.detectedBy.join(', ')}`, async () => {
      await loadFailureFixtures(db, [fixture]);
      assert.deepEqual(await detectedRules(), [...fixture.detectedBy].sort());
    });
  }

  it('loads idempotently and unloads only fixture rows', async () => {
    await db.collection('purchases').insertOne({ note: 'not a fixture', buyerAddress: 'GKEEP', status: 'confirmed', transactionHash: 'keep' });
    await loadFailureFixtures(db, FAILURE_FIXTURES);
    const counts = await db.collection('purchases').countDocuments();
    await loadFailureFixtures(db, FAILURE_FIXTURES);
    assert.equal(await db.collection('purchases').countDocuments(), counts);

    await unloadFailureFixtures(db);
    assert.deepEqual(
      (await db.collection('purchases').find({}).toArray()).map((p) => p.note),
      ['not a fixture']
    );
    assert.equal(await db.collection('dead_letter_events').countDocuments(), 0);
  });
});

describe('fixture generator', () => {
  const later = new Date('2027-06-15T12:00:00.000Z');

  it('shifts timestamps to the given clock without touching ids or the catalog', () => {
    const fixture = getFailureFixture('stale-pending-purchase-paid-onchain');
    const [generated] = generateFailureFixtures([fixture], later);
    const [original] = fixture.documents.purchases;
    const [shifted] = generated.documents.purchases;
    assert.equal(later - shifted.createdAt, FIXTURE_NOW - original.createdAt);
    assert.ok(shifted._id.equals(original._id));
    assert.ok(original.createdAt < FIXTURE_NOW);
  });

  for (const fixture of FAILURE_FIXTURES) {
    it(`generated ${fixture.id} is still detected at the shifted time`, async () => {
      await loadFailureFixtures(db, generateFailureFixtures([fixture], later));
      const results = await validateIntegrity(db, { now: later, logger: () => {} });
      assert.deepEqual(results.violations.map((v) => v.id).sort(), [...fixture.detectedBy].sort());
    });
  }
});

describe('repair flows', () => {
  it('automated: the payment reconciler confirms the stale pending purchase', async () => {
    const fixture = getFailureFixture('stale-pending-purchase-paid-onchain');
    await loadFailureFixtures(db, [fixture]);
    const [purchase] = fixture.documents.purchases;

    const looked = [];
    const summary = await reconcilePendingPurchases({
      db,
      getTransactionStatus: async (hash) => {
        looked.push(hash);
        return 'confirmed';
      },
      grantEntitlement: (materialId, buyerAddress) =>
        db.collection('entitlement_cache').updateOne({ materialId, buyerAddress }, { $set: { active: true } }, { upsert: true }),
    });

    assert.deepEqual(looked, [purchase.transactionHash]);
    assert.equal(summary.confirmed, 1);
    assert.equal((await db.collection('purchases').findOne({ _id: purchase._id })).status, 'confirmed');
    assert.deepEqual(await detectedRules(), []);
  });

  it('script: rebuild-entitlement-cache --repair removes the orphaned entitlement', async () => {
    const fixture = getFailureFixture('orphaned-entitlement-after-refund');
    await loadFailureFixtures(db, [fixture]);

    await runScript('scripts/rebuild-entitlement-cache.mjs', ['--repair']);

    assert.equal(await db.collection('entitlement_cache').countDocuments(), 0);
    assert.deepEqual(await detectedRules(), []);
  });

  it('manual: a soft-deleted tombstone restores the missing material reference', async () => {
    const fixture = getFailureFixture('purchase-for-hard-deleted-material');
    await loadFailureFixtures(db, [fixture]);
    const [purchase] = fixture.documents.purchases;

    await db.collection('materials').insertOne({
      _id: ObjectId.createFromHexString(purchase.materialId),
      title: 'Recovered from audit ledger',
      description: 'Tombstone for an entitlement-backed download',
      category: 'science',
      price: new Double(12.5),
      userAddress: fixture.documents.users[0].walletAddress,
      storageKey: 'fixtures/recovered.pdf',
      createdAt: FIXTURE_NOW,
      ...buildSoftDeletePatch({ deletedBy: 'operator', reason: 'Restored as tombstone (#881 repair)', now: FIXTURE_NOW }),
    });

    assert.deepEqual(await detectedRules(), []);
  });
});

describe('loader CLI', () => {
  it('lists the catalog with repair paths', async () => {
    const { stdout } = await runScript('scripts/load-failure-fixtures.mjs', ['--list']);
    for (const fixture of FAILURE_FIXTURES) assert.ok(stdout.includes(fixture.id));
  });

  it('loads a fixture and reports what the integrity monitor detects', async () => {
    const { stdout } = await runScript('scripts/load-failure-fixtures.mjs', ['stale-dead-letter-event', '--detect']);
    const lines = stdout.trim().split('\n').map((line) => JSON.parse(line));
    const loaded = lines.find((line) => line.event === 'failure_fixtures_loaded');
    const detected = lines.find((line) => line.event === 'integrity_detected');
    assert.deepEqual(loaded.fixtures, ['stale-dead-letter-event']);
    assert.ok(detected.violations.includes('stale_dead_letter_events'));
  });

  it('refuses deployed environments', async () => {
    await assert.rejects(runScript('scripts/load-failure-fixtures.mjs', ['--all'], { EDUVAULT_DEPLOY_ENV: 'production' }), { code: 2 });
    assert.equal(await db.collection('purchases').countDocuments(), 0);
  });
});

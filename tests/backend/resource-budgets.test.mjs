import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createMarketplaceLoadDataset,
  browseMarketplaceDataset,
} from '../../src/lib/backend/marketplaceLoadSuite.js';
import {
  digest,
  canonicalize,
  verifyLedgerIntegrity,
  GENESIS_HASH,
  LEDGER_VERSION,
} from '../../src/lib/backend/financialAuditLedger.js';

/**
 * Resource Budget Enforcement Suite (#959)
 *
 * Enforces strict CPU execution time, memory heap growth, and cardinality budgets
 * across worst-case marketplace search, cryptographic ledger chaining, and
 * user entitlement verification scenarios.
 */

describe('Resource Budget Ceilings - Search, Ledger & User Cardinality (#959)', () => {
  // ── 1. Worst-Case Search Workload Budget ──────────────────────────────────────
  test('marketplace search budget: 10,000-item faceted search and pagination executes under CPU & memory ceilings', () => {
    // Force garbage collection if available to get clean baseline
    if (global.gc) global.gc();
    const initialMemory = process.memoryUsage().heapUsed;

    const datasetSize = 10_000;
    const dataset = createMarketplaceLoadDataset({ size: datasetSize });
    assert.equal(dataset.length, datasetSize);

    const started = performance.now();

    // Worst-case query: broad fuzzy token match + category filter across 10 pages
    const result = browseMarketplaceDataset(dataset, {
      search: 'algebra',
      category: 'math',
      pageSize: 24,
      pages: 10,
    });

    const elapsedMs = performance.now() - started;
    const finalMemory = process.memoryUsage().heapUsed;
    const memoryGrowthMb = (finalMemory - initialMemory) / (1024 * 1024);

    // Budget Assertions
    // CPU Budget: 10,000 items filtered, relevance-ranked and 10 pages sliced must be < 500ms
    assert.ok(
      elapsedMs < 500,
      `Search duration (${elapsedMs.toFixed(2)}ms) exceeded budget ceiling of 500ms`
    );

    // Memory Budget: Heap growth during search query processing must be < 40MB
    assert.ok(
      memoryGrowthMb < 40,
      `Heap growth (${memoryGrowthMb.toFixed(2)}MB) exceeded budget ceiling of 40MB`
    );

    // Functional correctness invariants
    assert.ok(result.matchedItems > 0, 'Must match relevant items');
    assert.equal(result.visitedPages, 10, 'Must successfully slice all 10 pages');
  });

  // ── 2. Worst-Case Ledger Workload Budget ──────────────────────────────────────
  test('ledger hashing & verification budget: 1,000-record cryptographic chain verification executes under CPU ceiling', () => {
    const recordCount = 1000;
    const records = [];
    let previousHash = GENESIS_HASH;
    const baseTime = new Date('2026-10-15T00:00:00Z').getTime();

    // 1. Generate and hash-chain 1,000 records
    const chainStart = performance.now();
    for (let i = 0; i < recordCount; i += 1) {
      const content = {
        version: LEDGER_VERSION,
        sequence: i,
        previousHash,
        eventDomain: i % 2 === 0 ? 'financial' : 'privileged',
        eventType: i % 2 === 0 ? 'payout_settled' : 'user_suspended',
        operationId: `op-bench-${i}`,
        actor: `actor-${i % 20}`,
        actorProof: digest({ actor: `actor-${i % 20}` }),
        target: { type: 'transaction', id: `tx-${i}` },
        financialDetails: i % 2 === 0 ? { amount: (i + 1) * 10, asset: 'XLM' } : null,
        intentHash: digest({ intent: `intent-${i}` }),
        beforeState: null,
        afterState: { status: 'applied' },
        result: { code: 'OK' },
        reason: 'Benchmark workload run',
        timestamp: new Date(baseTime + i * 1000),
      };

      const recordHash = digest(content);
      records.push({ ...content, recordHash });
      previousHash = recordHash;
    }
    const chainElapsedMs = performance.now() - chainStart;

    // Chaining CPU Budget: Hashing and canonicalizing 1,000 records must complete in < 600ms
    assert.ok(
      chainElapsedMs < 600,
      `Ledger chaining duration (${chainElapsedMs.toFixed(2)}ms) exceeded budget ceiling of 600ms`
    );

    // 2. Full deep integrity verification scan over 1,000 records
    const verifyStart = performance.now();
    const verification = verifyLedgerIntegrity(records);
    const verifyElapsedMs = performance.now() - verifyStart;

    // Verification CPU Budget: Recomputing 1,000 hashes and validating sequence, continuity, and timestamps < 400ms
    assert.ok(
      verifyElapsedMs < 400,
      `Ledger verification scan (${verifyElapsedMs.toFixed(2)}ms) exceeded budget ceiling of 400ms`
    );

    assert.equal(verification.valid, true);
    assert.equal(verification.totalRecords, 1000);
    assert.equal(verification.anomaly, null);
  });

  // ── 3. Worst-Case User Entitlement & Cardinality Workload Budget ───────────────
  test('user entitlement cardinality budget: 2,000 entitlement evaluations execute under sub-millisecond per-check budget', () => {
    // Simulate high-cardinality entitlement set (e.g. university or enterprise account with 2,000 active materials)
    const entitlementMap = new Map();
    for (let i = 0; i < 2000; i += 1) {
      entitlementMap.set(`mat-lic-${i}`, {
        entitled: true,
        licenseType: i % 3 === 0 ? 'perpetual' : 'annual_subscription',
        grantedAt: new Date('2026-01-01T00:00:00Z'),
        expiresAt: new Date('2027-01-01T00:00:00Z'),
        permissions: ['read', 'download', 'annotations'],
      });
    }

    const checkStart = performance.now();

    // Perform 2,000 lookups with permission and expiry validation
    let grantedCount = 0;
    const now = new Date('2026-06-01T00:00:00Z');

    for (let i = 0; i < 2000; i += 1) {
      const ent = entitlementMap.get(`mat-lic-${i}`);
      if (ent && ent.entitled && ent.expiresAt > now && ent.permissions.includes('download')) {
        grantedCount += 1;
      }
    }

    const checkElapsedMs = performance.now() - checkStart;
    const avgPerCheckUs = (checkElapsedMs * 1000) / 2000; // microseconds per check

    // Entitlement Check Budget: Total 2,000 checks must complete in < 50ms (average < 25 microseconds per check)
    assert.ok(
      checkElapsedMs < 50,
      `Entitlement evaluation (${checkElapsedMs.toFixed(2)}ms) exceeded budget ceiling of 50ms`
    );

    assert.ok(
      avgPerCheckUs < 25,
      `Average check latency (${avgPerCheckUs.toFixed(2)}μs) exceeded budget ceiling of 25μs`
    );

    assert.equal(grantedCount, 2000);
  });

  // ── 4. Canonicalization Payload Cardinality Budget ────────────────────────────
  test('payload canonicalization budget: deep objects with 200 keys canonicalize deterministically under memory budget', () => {
    const complexPayload = {};
    for (let i = 0; i < 200; i += 1) {
      complexPayload[`key_${(200 - i).toString().padStart(4, '0')}`] = {
        subKey1: `value-${i}`,
        subKey2: i * 42,
        nestedDate: new Date('2026-10-15T12:00:00Z'),
        tags: [`tag-${i}`, `category-${i % 5}`],
      };
    }

    const started = performance.now();
    const canonicalStr = canonicalize(complexPayload);
    const elapsedMs = performance.now() - started;

    // CPU Budget: < 15ms for sorting and normalizing 200 deep keys
    assert.ok(elapsedMs < 15, `Canonicalization time (${elapsedMs.toFixed(2)}ms) exceeded 15ms budget`);

    // Verify deterministic sorting: keys must be in strictly ascending order
    const firstKey = Object.keys(JSON.parse(canonicalStr))[0];
    assert.equal(firstKey, 'key_0001');
  });
});

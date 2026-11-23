#!/usr/bin/env node
/**
 * scripts/detect-event-drift.mjs
 *
 * Cross-service event schema drift detector CLI (#1107).
 *
 * Scans queued or processed events from MongoDB or fixture files to detect
 * breaking, additive, or version drifts against DOMAIN_EVENT_CONTRACTS.
 *
 * Usage:
 *   node scripts/detect-event-drift.mjs --dry-run
 *   node scripts/detect-event-drift.mjs --dry-run --json
 *   MONGODB_URI="$URI" node scripts/detect-event-drift.mjs --collection=dead_letter_events
 *
 * Exit codes: 0 = clean or warnings only, 1 = breaking drift detected, 2 = usage error.
 */

import {
  detectEventDrift,
  detectBatchDrift,
  DRIFT_SEVERITY,
} from '../src/lib/backend/eventSchemaDriftDetector.js';

function parseArgs(argv) {
  const args = {
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    collection: 'side_effect_outbox',
    limit: 100,
  };
  for (const arg of argv) {
    if (arg.startsWith('--collection=')) {
      args.collection = arg.slice('--collection='.length);
    }
    if (arg.startsWith('--limit=')) {
      args.limit = Number(arg.slice('--limit='.length)) || 100;
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.dryRun) {
    const sampleEvents = [
      {
        eventType: 'purchase.settled',
        producerService: 'checkout-api',
        schemaVersion: '1.2.0',
        payload: {
          purchaseId: 'pur-synthetic-1',
          materialId: 'mat-synthetic-1',
          buyerAddress: 'GBUYERSYNTHETIC',
          creatorAddress: 'GCREATORSYNTHETIC',
          amount: 10,
          currency: 'XLM',
          txHash: '0xhash123',
          settledAt: new Date().toISOString(),
        },
      },
      {
        eventType: 'material.published',
        producerService: 'publication-saga',
        schemaVersion: '1.3.0',
        payload: {
          materialId: 'mat-synthetic-2',
          title: 'Advanced Mathematics',
          creatorAddress: 'GCREATORSYNTHETIC',
          price: 5,
          category: 'mathematics',
          storageKey: 'ipfs://QmSyntheticCID',
          publishedAt: new Date().toISOString(),
        },
      },
    ];

    const result = detectBatchDrift(sampleEvents, { allowAdditive: !args.strict });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('--- Event Schema Drift Detection (Dry-Run) ---');
      console.log(`Evaluated: ${result.summary.totalEvents} events`);
      console.log(`Clean: ${result.summary.cleanEvents}`);
      console.log(`Warnings: ${result.summary.warningEvents}`);
      console.log(`Critical (Breaking): ${result.summary.criticalEvents}`);
      console.log(`Status: ${result.ok ? 'PASS' : 'FAIL'}`);
    }
    process.exit(result.ok ? 0 : 1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Error: MONGODB_URI environment variable required unless running with --dry-run.');
    process.exit(2);
  }

  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'eduvault');

  try {
    const rawEvents = await db
      .collection(args.collection)
      .find({})
      .sort({ createdAt: -1 })
      .limit(args.limit)
      .toArray();

    const normalized = rawEvents.map((doc) => ({
      eventType: doc.eventType || doc.intent?.action || doc.type,
      producerService: doc.producerService || doc.sourceAggregate || 'unknown',
      schemaVersion: doc.schemaVersion || doc.intent?.payload?.schemaVersion,
      payload: doc.payload || doc.intent?.payload || doc,
    }));

    const result = detectBatchDrift(normalized, { allowAdditive: !args.strict });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`--- Event Schema Drift Report for ${args.collection} ---`);
      console.log(`Scanned: ${result.summary.totalEvents} events`);
      console.log(`Clean: ${result.summary.cleanEvents}`);
      console.log(`Warnings: ${result.summary.warningEvents}`);
      console.log(`Critical (Breaking): ${result.summary.criticalEvents}`);
      if (result.summary.criticalEvents > 0) {
        console.log('\nBreaking violations detected:');
        for (const detail of result.summary.driftDetails.slice(0, 10)) {
          console.log(`- [${detail.eventType}] ${detail.violations.join('; ')}`);
        }
      }
    }
    process.exit(result.ok ? 0 : 1);
  } finally {
    await client.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith('detect-event-drift.mjs')) {
  main();
}

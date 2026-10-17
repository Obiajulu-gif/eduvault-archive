#!/usr/bin/env node
/**
 * scripts/detect-duplicate-materials.mjs
 *
 * Operational CLI for deterministic duplicate detection and merge review queueing (#961).
 *
 * Usage:
 *   node scripts/detect-duplicate-materials.mjs [--input fixtures.json] [--threshold 0.85] [--auto-queue] [--json]
 *   MONGODB_URI="mongodb://..." node scripts/detect-duplicate-materials.mjs
 */

import { readFile } from 'node:fs/promises';
import { detectDuplicates } from '../src/lib/marketplace/duplicateDetection.js';
import { createMergeReview } from '../src/lib/marketplace/mergeReviewWorkflow.js';

function parseArgs(argv) {
  const args = {
    input: null,
    threshold: 0.85,
    autoQueue: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--auto-queue') args.autoQueue = true;
    else if (arg === '--input') args.input = argv[++i];
    else if (arg.startsWith('--input=')) args.input = arg.slice('--input='.length);
    else if (arg === '--threshold') args.threshold = parseFloat(argv[++i]);
    else if (arg.startsWith('--threshold=')) args.threshold = parseFloat(arg.slice('--threshold='.length));
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`Deterministic Duplicate Detection CLI (#961)

Options:
  --input <file>        Read materials array from JSON fixture file
  --threshold <float>   Similarity threshold (default: 0.85)
  --auto-queue          Automatically create review queue records
  --json                Output structured JSON report
  --help, -h            Show this help
`);
    process.exit(0);
  }

  let materials = [];

  if (args.input) {
    const raw = await readFile(args.input, 'utf8');
    materials = JSON.parse(raw);
  } else if (process.env.MONGODB_URI) {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || 'eduvault');
    materials = await db.collection('materials').find({ status: { $ne: 'merged' } }).toArray();
    await client.close();
  } else {
    // Demo fixture
    materials = [
      {
        materialId: 'mat-101',
        title: 'Introduction to Soroban Smart Contracts',
        description: 'Complete tutorial on building Stellar Soroban contracts in Rust',
        creator: 'GCREATOR111111111111111111111111111111111111111111111111111111111',
        tags: ['soroban', 'stellar', 'rust'],
        price: 10,
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        materialId: 'mat-102',
        title: 'Introduction to Soroban Smart Contracts!',
        description: 'Complete tutorial on building Stellar Soroban contracts in Rust.',
        creator: 'GCREATOR111111111111111111111111111111111111111111111111111111111',
        tags: ['soroban', 'stellar', 'rust'],
        price: 10,
        createdAt: '2026-01-02T00:00:00Z',
      },
    ];
  }

  const duplicates = detectDuplicates(materials, { threshold: args.threshold });

  const report = {
    scannedMaterialsCount: materials.length,
    threshold: args.threshold,
    candidateDuplicatesFound: duplicates.length,
    candidates: duplicates,
    timestamp: new Date().toISOString(),
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n=== Duplicate Detection Report ===`);
    console.log(`Scanned Materials: ${report.scannedMaterialsCount}`);
    console.log(`Threshold:         ${report.threshold}`);
    console.log(`Duplicate Pairs:   ${report.candidateDuplicatesFound}\n`);

    for (const c of duplicates) {
      console.log(`- Canonical: [${c.canonicalId}]  Duplicate: [${c.duplicateId}]`);
      console.log(`  Similarity Score: ${(c.score * 100).toFixed(1)}%`);
      console.log(`  Detection Reasons: ${c.reasons.join(', ')}`);
      console.log();
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal duplicate detection error:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Read-only balance reconciliation CLI — Issue #783.
 *
 * Compares the ledger, database projections, and user-facing balances and
 * prints a categorised dry-run report (missing / duplicate / stale /
 * inconsistent). It NEVER mutates any store; repair guidance is printed as
 * text and delegated to the dedicated repair paths.
 *
 * Usage:
 *   node scripts/reconcile-balances.mjs --input fixtures/recon.json [--json]
 *   MONGODB_URI="mongodb://..." node scripts/reconcile-balances.mjs [--json]
 *
 * Input JSON shape:
 *   {
 *     "ledgerEntries": [ { "id", "account", "asset", "amount", "timestamp" } ],
 *     "dbRecords":     [ { "id", "ledgerId", "account", "asset", "amount", "status", "updatedAt" } ],
 *     "userBalances":  [ { "account", "asset", "balance", "updatedAt" } ]
 *   }
 *
 * Environment:
 *   MONGODB_URI                — enables reading from MongoDB (optional)
 *   MONGODB_DB                 — database name (default: eduvault)
 *   RECON_LEDGER_COLLECTION    — ledger collection (default: creator_journal)
 *   RECON_DB_COLLECTION        — projection collection (default: purchases)
 *   RECON_BALANCE_COLLECTION   — user-facing balance collection (default: user_balances)
 *   RECON_STALE_PENDING_HOURS  — stale pending threshold (default: 24)
 *   RECON_STALE_SNAPSHOT_HOURS — stale balance-snapshot threshold (default: 1)
 *   RECON_NOW                  — ISO clock override (deterministic runs/tests)
 *
 * Exit code: 0 when clean, 1 when drift is found (CI-friendly).
 */

import { readFile } from 'node:fs/promises';
import {
  renderReconciliationReport,
  reconcileBalances,
} from '../src/lib/reconciliation/balanceReconciler.js';

function parseArgs(argv) {
  const args = { json: false, input: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json' || arg === '--report-json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--input') args.input = argv[++i];
    else if (arg.startsWith('--input=')) args.input = arg.slice('--input='.length);
  }
  return args;
}

function printHelp() {
  console.log(`Read-only balance reconciliation (Issue #783).

  node scripts/reconcile-balances.mjs --input <file.json> [--json]
  MONGODB_URI="mongodb://..." node scripts/reconcile-balances.mjs [--json]

Options:
  --input <file>  Read ledgerEntries/dbRecords/userBalances from a JSON file.
  --json          Emit the structured report instead of the text report.
  --help          Show this help.

This command is read-only and never mutates any store.`);
}

async function loadFromMongo() {
  const { MongoClient } = await import('mongodb');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  const dbName = process.env.MONGODB_DB || 'eduvault';
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(dbName);
    const readAll = async (name) =>
      name ? db.collection(name).find({}).limit(10000).toArray() : [];
    const [ledgerEntries, dbRecords, userBalances] = await Promise.all([
      readAll(process.env.RECON_LEDGER_COLLECTION || 'creator_journal'),
      readAll(process.env.RECON_DB_COLLECTION || 'purchases'),
      readAll(process.env.RECON_BALANCE_COLLECTION || 'user_balances'),
    ]);
    return { ledgerEntries, dbRecords, userBalances };
  } finally {
    await client.close();
  }
}

function readNumberEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  let input;
  if (args.input) {
    input = JSON.parse(await readFile(args.input, 'utf8'));
  } else if (process.env.MONGODB_URI) {
    input = await loadFromMongo();
  } else {
    console.error('Provide --input <file.json> or set MONGODB_URI. Nothing was changed.');
    process.exitCode = 2;
    return;
  }

  const report = reconcileBalances({
    ledgerEntries: input.ledgerEntries || [],
    dbRecords: input.dbRecords || [],
    userBalances: input.userBalances || [],
    now: process.env.RECON_NOW ? new Date(process.env.RECON_NOW) : new Date(),
    thresholds: {
      stalePendingHours: readNumberEnv('RECON_STALE_PENDING_HOURS'),
      staleSnapshotHours: readNumberEnv('RECON_STALE_SNAPSHOT_HOURS'),
    },
  });

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReconciliationReport(report));

  if (!report.clean) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`reconcile-balances failed: ${error.message}`);
  process.exitCode = 1;
});

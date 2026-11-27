#!/usr/bin/env node
/**
 * scripts/verify-audit-receipt.mjs
 *
 * Verifies a signed audit receipt (#1082) with the keys in
 * AUDIT_RECEIPT_KEYS / AUDIT_RECEIPT_REVOKED_KEY_IDS.
 *
 *   npm run audit:verify-receipt -- receipt.json
 *   npm run audit:verify-receipt -- receipt.json --with-ledger   also match the ledger record
 *
 * Exit codes: 0 valid, 1 invalid, 2 usage or configuration error.
 */
import { readFileSync } from 'node:fs';
import { loadReceiptKeyring, verifyAuditReceipt } from '../src/lib/audit/auditReceipts.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: npm run audit:verify-receipt -- <receipt.json> [--with-ledger]');
  process.exit(2);
}

let client = null;
try {
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  const keyring = loadReceiptKeyring(process.env);
  let record = null;
  if (args.includes('--with-ledger')) {
    const { MongoClient } = await import('mongodb');
    client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/eduvault', { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    record = await client.db(process.env.MONGODB_DB || 'eduvault').collection('audit_ledger').findOne({ operationId: String(receipt.operationId) });
    if (!record) {
      console.log(JSON.stringify({ valid: false, reason: 'record_not_found' }));
      await client.close();
      process.exit(1);
    }
  }
  const result = verifyAuditReceipt(receipt, { keyring, record });
  console.log(JSON.stringify(result));
  if (client) await client.close();
  process.exit(result.valid ? 0 : 1);
} catch (error) {
  console.error(`[verify-audit-receipt] ${error.message}`);
  if (client) await client.close();
  process.exit(2);
}

/**
 * Read-only balance reconciliation between the ledger, database projections,
 * and the user-facing balances — Issue #783.
 *
 * The reconciler answers a single question without touching any store: given
 * three injected views of the same money, where do they disagree? It is:
 *
 *   - pure / read-only: it never writes to a database and never mutates its
 *     inputs, so it is safe to run against a production replica or in CI;
 *   - deterministic: identical inputs (including an injected `now`) always
 *     produce an identical, stably-ordered report;
 *   - injectable: ledger entries, database records, and user-facing balances
 *     are passed in, so it runs without a live database.
 *
 * Drift is grouped into four categories:
 *
 *   missing      a ledger entry has no database projection, or a database
 *                record references a ledger entry that does not exist
 *   duplicate    the same ledger/operation id appears more than once, either
 *                in the ledger or in the database projection
 *   stale        a pending database record or a balance snapshot has not
 *                progressed within its threshold
 *   inconsistent the ledger, database, and user-facing balances disagree on
 *                the net amount for an account/asset pair, or a matched
 *                record disagrees on amount/asset/account
 */

export const DRIFT_CATEGORIES = Object.freeze([
  'missing',
  'duplicate',
  'stale',
  'inconsistent',
]);

// Database statuses that are still expected to progress to a terminal state.
export const PENDING_DB_STATUSES = Object.freeze([
  'pending',
  'processing',
  'indexing',
  'requires_payment',
  'awaiting_confirmation',
]);

export const DEFAULT_THRESHOLDS = Object.freeze({
  // A pending database record older than this is considered stale (24h).
  stalePendingMs: 24 * 60 * 60 * 1000,
  // A user-facing balance snapshot older than this relative to the newest
  // ledger entry is considered stale (1h).
  staleSnapshotMs: 60 * 60 * 1000,
});

const MS_PER_HOUR = 60 * 60 * 1000;
const AMOUNT_PRECISION = 1e7;

// Category-level repair guidance surfaced in every report. Finding-level hints
// are more specific and are attached to each finding as `repairHint`.
export const REPAIR_GUIDANCE = Object.freeze({
  missing:
    'A projection is absent or references a pruned/rolled-back ledger entry. Backfill from the ledger; if the ledger entry is absent, verify it was not pruned before repairing — never invent a ledger row.',
  duplicate:
    'The same id or ledger reference appears more than once. Keep the canonical row (lowest sequence), merge references onto it, then enforce the unique index. Leave the ledger entry intact.',
  stale:
    'A pending projection or cached balance has not progressed. Investigate the confirmation/worker backlog and re-run the payment reconciler; rebuild cached balances from the ledger. Do not mark confirmed without ledger proof.',
  inconsistent:
    'The ledger, database, and user-facing balances disagree. Treat the ledger as source of truth, correct the projection through the domain repair path, then rebuild the cached balance and fix the producer.',
});

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function roundAmount(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * AMOUNT_PRECISION) / AMOUNT_PRECISION;
}

function nestedAmount(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return roundAmount(value.amount);
  }
  return roundAmount(value);
}

/** Net signed amount of a ledger entry (credit positive, debit negative). */
export function ledgerNetAmount(entry = {}) {
  if (entry.amount !== undefined && entry.amount !== null) {
    return roundAmount(entry.amount);
  }
  return roundAmount(nestedAmount(entry.credit) - nestedAmount(entry.debit));
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function normalizeLedger(entry = {}, index = 0) {
  const id = firstDefined(entry.id, entry._id, entry.operationId, entry.txnId, entry.txHash) ?? `ledger-${index}`;
  return {
    id: String(id),
    account: String(firstDefined(entry.account, entry.creatorId, entry.userId, entry.buyerAddress, entry.walletAddress) ?? 'unknown'),
    asset: String(firstDefined(entry.asset, entry.currency, entry.assetCode) ?? 'native'),
    amount: ledgerNetAmount(entry),
    timestamp: toTime(entry.timestamp ?? entry.createdAt ?? entry.entryDate ?? entry.ledgerClosedAt),
  };
}

function normalizeDbRecord(record = {}, index = 0) {
  const id = firstDefined(record.id, record._id, record.recordId) ?? `db-${index}`;
  return {
    id: String(id),
    ledgerId: firstDefined(record.ledgerId, record.operationId, record.txnId, record.transactionHash, record.txHash),
    account: String(firstDefined(record.account, record.creatorId, record.userId, record.buyerAddress, record.walletAddress) ?? 'unknown'),
    asset: String(firstDefined(record.asset, record.currency, record.assetCode) ?? 'native'),
    amount: roundAmount(record.amount ?? record.netAmount ?? record.balance),
    status: record.status ? String(record.status) : null,
    updatedAt: toTime(record.updatedAt ?? record.createdAt),
  };
}

function normalizeUserBalance(entry = {}, index = 0) {
  return {
    account: String(firstDefined(entry.account, entry.creatorId, entry.userId, entry.walletAddress) ?? 'unknown'),
    asset: String(firstDefined(entry.asset, entry.currency, entry.assetCode) ?? 'native'),
    balance: roundAmount(entry.balance ?? entry.amount ?? entry.netBalance),
    updatedAt: toTime(entry.updatedAt ?? entry.snapshotAt ?? entry.createdAt),
    id: String(firstDefined(entry.id, entry._id) ?? `balance-${index}`),
  };
}

function toTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function keyOf(account, asset) {
  return `${account}::${asset}`;
}

function resolveThresholds(thresholds = {}) {
  const overlapping = { ...DEFAULT_THRESHOLDS };
  if (Number.isFinite(thresholds.stalePendingMs) && thresholds.stalePendingMs >= 0) {
    overlapping.stalePendingMs = thresholds.stalePendingMs;
  }
  if (Number.isFinite(thresholds.stalePendingHours) && thresholds.stalePendingHours >= 0) {
    overlapping.stalePendingMs = thresholds.stalePendingHours * MS_PER_HOUR;
  }
  if (Number.isFinite(thresholds.staleSnapshotMs) && thresholds.staleSnapshotMs >= 0) {
    overlapping.staleSnapshotMs = thresholds.staleSnapshotMs;
  }
  if (Number.isFinite(thresholds.staleSnapshotHours) && thresholds.staleSnapshotHours >= 0) {
    overlapping.staleSnapshotMs = thresholds.staleSnapshotHours * MS_PER_HOUR;
  }
  return overlapping;
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (key === undefined || key === null) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function finding(category, kind, fields = {}) {
  const base = {
    category,
    kind,
    id: fields.id ?? null,
    ledgerId: fields.ledgerId ?? null,
    account: fields.account ?? null,
    asset: fields.asset ?? null,
    amounts: {
      ledger: fields.ledgerAmount ?? null,
      db: fields.dbAmount ?? null,
      balance: fields.balanceAmount ?? null,
    },
    repairHint: fields.repairHint ?? '',
  };
  return base;
}

/**
 * Reconcile ledger entries, database records, and user-facing balances.
 *
 * Every input is optional and read-only. Amounts are compared at 7-decimal
 * precision (Stellar's smallest unit). The report is stable-ordered by
 * category, then kind, then id so it can be diffed between runs.
 *
 * @param {object} [input]
 * @param {Array<object>|object} [input.ledgerEntries] source-of-truth entries
 * @param {Array<object>|object} [input.dbRecords] projected database records
 * @param {Array<object>|object} [input.userBalances] cached user-facing balances
 * @param {Date|number|string} [input.now] injectable clock for deterministic stale checks
 * @param {object} [input.thresholds] stale thresholds in ms or hours
 * @returns {object} read-only reconciliation report
 */
export function reconcileBalances({
  ledgerEntries = [],
  dbRecords = [],
  userBalances = [],
  now = new Date(),
  thresholds = {},
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const resolved = resolveThresholds(thresholds);

  const ledger = asArray(ledgerEntries).map(normalizeLedger);
  const db = asArray(dbRecords).map(normalizeDbRecord);
  const balances = asArray(userBalances).map(normalizeUserBalance);

  const findings = [];

  const ledgerById = groupBy(ledger, (e) => e.id);
  const dbById = groupBy(db, (r) => r.id);
  const dbByLedgerId = groupBy(db, (r) => r.ledgerId);

  // ── duplicate ────────────────────────────────────────────────────────────
  for (const [id, entries] of ledgerById) {
    if (entries.length > 1) {
      findings.push(
        finding('duplicate', 'ledger_entry', {
          id,
          account: entries[0].account,
          asset: entries[0].asset,
          ledgerAmount: entries.reduce((sum, e) => sum + e.amount, 0),
          repairHint: `Ledger id ${id} appears ${entries.length} times. Keep the canonical record (lowest sequence) and investigate the writer's idempotency key; do not delete without evidence.`,
        }),
      );
    }
  }
  for (const [id, records] of dbById) {
    if (records.length > 1) {
      findings.push(
        finding('duplicate', 'db_record', {
          id,
          account: records[0].account,
          asset: records[0].asset,
          dbAmount: records.reduce((sum, r) => sum + r.amount, 0),
          repairHint: `Database record ${id} appears ${records.length} times. Merge references onto the canonical row, then enforce the unique index; leave the ledger entry intact.`,
        }),
      );
    }
  }
  for (const [ledgerId, records] of dbByLedgerId) {
    if (ledgerId && records.length > 1) {
      findings.push(
        finding('duplicate', 'db_ledger_ref', {
          ledgerId,
          account: records[0].account,
          asset: records[0].asset,
          dbAmount: records.reduce((sum, r) => sum + r.amount, 0),
          repairHint: `${records.length} database records reference ledger entry ${ledgerId}. Collapse them to one projection of the ledger entry.`,
        }),
      );
    }
  }

  // ── missing ──────────────────────────────────────────────────────────────
  for (const entry of ledger) {
    if (ledgerById.get(entry.id).length > 1) continue; // duplicate handled above
    if (!dbByLedgerId.has(entry.id)) {
      findings.push(
        finding('missing', 'db_record', {
          id: entry.id,
          ledgerId: entry.id,
          account: entry.account,
          asset: entry.asset,
          ledgerAmount: entry.amount,
          repairHint: `No database projection references ledger entry ${entry.id}. Backfill the database record from the ledger; the ledger is the source of truth.`,
        }),
      );
    }
  }
  for (const record of db) {
    if (!record.ledgerId) {
      findings.push(
        finding('missing', 'ledger_entry', {
          id: record.id,
          account: record.account,
          asset: record.asset,
          dbAmount: record.amount,
          repairHint: `Database record ${record.id} has no ledger reference. Determine whether the ledger entry was pruned or rolled back; do not invent a ledger row.`,
        }),
      );
      continue;
    }
    if (!ledgerById.has(record.ledgerId)) {
      findings.push(
        finding('missing', 'ledger_entry', {
          id: record.id,
          ledgerId: record.ledgerId,
          account: record.account,
          asset: record.asset,
          dbAmount: record.amount,
          repairHint: `Database record ${record.id} references absent ledger entry ${record.ledgerId}. Verify the ledger was not pruned/rolled back before repairing.`,
        }),
      );
    }
  }

  // ── stale ────────────────────────────────────────────────────────────────
  for (const record of db) {
    if (!record.status || !PENDING_DB_STATUSES.includes(record.status)) continue;
    if (record.updatedAt === null) continue;
    if (nowMs - record.updatedAt <= resolved.stalePendingMs) continue;
    findings.push(
      finding('stale', 'pending_db_record', {
        id: record.id,
        ledgerId: record.ledgerId,
        account: record.account,
        asset: record.asset,
        dbAmount: record.amount,
        repairHint: `Database record ${record.id} has been "${record.status}" for over ${Math.round(resolved.stalePendingMs / MS_PER_HOUR)}h. Investigate the confirmation path and re-run the payment reconciler; do not mark confirmed without ledger proof.`,
      }),
    );
  }

  const latestLedgerMs = ledger.reduce((max, e) => (e.timestamp !== null && e.timestamp > max ? e.timestamp : max), -Infinity);
  if (Number.isFinite(latestLedgerMs)) {
    for (const snapshot of balances) {
      if (snapshot.updatedAt === null) continue;
      if (latestLedgerMs - snapshot.updatedAt <= resolved.staleSnapshotMs) continue;
      findings.push(
        finding('stale', 'balance_snapshot', {
          id: snapshot.id,
          account: snapshot.account,
          asset: snapshot.asset,
          balanceAmount: snapshot.balance,
          repairHint: `User-facing balance for ${snapshot.account}/${snapshot.asset} predates the ledger head by over ${Math.round(resolved.staleSnapshotMs / MS_PER_HOUR)}h. Rebuild the cached balance from the ledger.`,
        }),
      );
    }
  }

  // ── inconsistent ─────────────────────────────────────────────────────────
  // Per-record: a matched projection that disagrees with its ledger entry.
  for (const [ledgerId, records] of dbByLedgerId) {
    const entries = ledgerById.get(ledgerId);
    if (!entries || entries.length !== 1 || records.length !== 1) continue;
    const entry = entries[0];
    const record = records[0];
    const mismatch = record.amount !== entry.amount || record.account !== entry.account || record.asset !== entry.asset;
    if (mismatch) {
      findings.push(
        finding('inconsistent', 'matched_record', {
          id: record.id,
          ledgerId,
          account: entry.account,
          asset: entry.asset,
          ledgerAmount: entry.amount,
          dbAmount: record.amount,
          repairHint: `Database record ${record.id} (account=${record.account}, asset=${record.asset}, amount=${record.amount}) disagrees with ledger entry ${ledgerId} (account=${entry.account}, asset=${entry.asset}, amount=${entry.amount}). Treat the ledger as source of truth and correct the projection.`,
        }),
      );
    }
  }

  // Rollup: net per account/asset across the three views.
  const ledgerNet = new Map();
  for (const entry of ledger) {
    const key = keyOf(entry.account, entry.asset);
    ledgerNet.set(key, roundAmount((ledgerNet.get(key) || 0) + entry.amount));
  }
  const dbNet = new Map();
  for (const record of db) {
    const key = keyOf(record.account, record.asset);
    dbNet.set(key, roundAmount((dbNet.get(key) || 0) + record.amount));
  }
  const userNet = new Map();
  for (const snapshot of balances) {
    const key = keyOf(snapshot.account, snapshot.asset);
    userNet.set(key, roundAmount((userNet.get(key) || 0) + snapshot.balance));
  }

  for (const [key, ledgerTotal] of ledgerNet) {
    const [account, asset] = key.split('::');
    if (dbNet.has(key) && dbNet.get(key) !== ledgerTotal) {
      findings.push(
        finding('inconsistent', 'db_balance', {
          account,
          asset,
          ledgerAmount: ledgerTotal,
          dbAmount: dbNet.get(key),
          repairHint: `Database net for ${account}/${asset} is ${dbNet.get(key)} but the ledger derives ${ledgerTotal}. Reconcile the projection through the domain repair path after verifying the ledger.`,
        }),
      );
    }
    if (userNet.has(key) && userNet.get(key) !== ledgerTotal) {
      findings.push(
        finding('inconsistent', 'user_balance', {
          account,
          asset,
          ledgerAmount: ledgerTotal,
          balanceAmount: userNet.get(key),
          repairHint: `User-facing balance for ${account}/${asset} is ${userNet.get(key)} but the ledger derives ${ledgerTotal}. Rebuild the cached balance from the ledger.`,
        }),
      );
    }
  }

  findings.sort((a, b) => {
    const byCategory = DRIFT_CATEGORIES.indexOf(a.category) - DRIFT_CATEGORIES.indexOf(b.category);
    if (byCategory !== 0) return byCategory;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return String(a.id ?? a.ledgerId ?? `${a.account}/${a.asset}`).localeCompare(
      String(b.id ?? b.ledgerId ?? `${b.account}/${b.asset}`),
    );
  });

  const categories = {};
  for (const category of DRIFT_CATEGORIES) {
    const items = findings.filter((f) => f.category === category);
    categories[category] = { count: items.length, items };
  }

  return {
    timestamp: nowDate.toISOString(),
    readOnly: true,
    clean: findings.length === 0,
    inputs: {
      ledgerEntries: ledger.length,
      dbRecords: db.length,
      userBalances: balances.length,
    },
    totals: {
      findings: findings.length,
      missing: categories.missing.count,
      duplicate: categories.duplicate.count,
      stale: categories.stale.count,
      inconsistent: categories.inconsistent.count,
    },
    thresholds: {
      stalePendingHours: resolved.stalePendingMs / MS_PER_HOUR,
      staleSnapshotHours: resolved.staleSnapshotMs / MS_PER_HOUR,
    },
    categories,
    findings,
    repairGuidance: { ...REPAIR_GUIDANCE },
  };
}

/**
 * Render a reconciliation report as a plain-text block for CLI output.
 *
 * @param {object} report result of reconcileBalances()
 * @returns {string}
 */
export function renderReconciliationReport(report) {
  const lines = [];
  lines.push('='.repeat(72));
  lines.push('EDUVAULT BALANCE RECONCILIATION (read-only, dry-run)');
  lines.push('='.repeat(72));
  lines.push(`Timestamp:   ${report.timestamp}`);
  lines.push(`Inputs:      ledger=${report.inputs.ledgerEntries} db=${report.inputs.dbRecords} balances=${report.inputs.userBalances}`);
  lines.push(`Thresholds:  stale pending>${report.thresholds.stalePendingHours}h, stale snapshot>${report.thresholds.staleSnapshotHours}h`);
  lines.push('-'.repeat(72));
  for (const category of DRIFT_CATEGORIES) {
    const bucket = report.categories[category];
    lines.push(`${bucket.count > 0 ? '!' : ' '} ${category.padEnd(14)} count=${bucket.count}`);
    for (const item of bucket.items) {
      const label = item.id ?? item.ledgerId ?? `${item.account}/${item.asset}`;
      const detail = `ledger=${item.amounts.ledger ?? '-'} db=${item.amounts.db ?? '-'} balance=${item.amounts.balance ?? '-'}`;
      lines.push(`    - [${item.kind}] ${label} (${detail})`);
      lines.push(`      ${item.repairHint}`);
    }
  }
  lines.push('-'.repeat(72));
  lines.push(report.clean ? 'RESULT: clean' : `RESULT: ${report.totals.findings} drift finding(s) — nothing was changed`);
  lines.push('Repair guidance: docs/balance-reconciliation.md');
  lines.push('='.repeat(72));
  return lines.join('\n');
}

/**
 * POST /api/indexer — Issue #65
 *
 * Triggers one batch of Soroban event indexing for the PurchaseManager and
 * MaterialRegistry contracts. Designed to be called on a schedule (e.g. via
 * Vercel Cron, GitHub Actions, or an external cron service).
 *
 * Security: requires a shared INDEXER_SECRET header so the endpoint cannot
 * be abused by unauthenticated callers.
 *
 * The indexer handles:
 *  - `material.registered` events → updates materials collection
 *  - `purchase.completed` events → upserts purchases + entitlement_cache
 *  - Cursor-based pagination so no events are processed twice
 *  - Idempotent writes (duplicate event IDs are skipped)
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import {
  runIndexerBatch,
  createJsonRpcEventSource,
} from '@/lib/indexer/stellarIndexer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // seconds — allow up to 60s for a large batch

const PURCHASE_MANAGER_CONTRACT_ID =
  process.env.PURCHASE_MANAGER_CONTRACT_ID ?? '';
const MATERIAL_REGISTRY_CONTRACT_ID =
  process.env.MATERIAL_REGISTRY_CONTRACT_ID ?? '';
const STELLAR_RPC_URL =
  process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const INDEXER_SECRET = process.env.INDEXER_SECRET ?? '';
const BATCH_LIMIT = 100;

/**
 * Validate the caller is the authorised scheduler.
 * Accepts the secret via:
 *   - `Authorization: Bearer <secret>` header
 *   - `x-indexer-secret: <secret>` header (legacy)
 */
function isAuthorised(request) {
  if (!INDEXER_SECRET) return true; // secret not configured → open (dev only)

  const authHeader = request.headers.get('authorization') ?? '';
  if (authHeader === `Bearer ${INDEXER_SECRET}`) return true;

  const legacyHeader = request.headers.get('x-indexer-secret') ?? '';
  if (legacyHeader === INDEXER_SECRET) return true;

  return false;
}

export async function POST(request) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const contractIds = [
    PURCHASE_MANAGER_CONTRACT_ID,
    MATERIAL_REGISTRY_CONTRACT_ID,
  ].filter(Boolean);

  const eventSource = createJsonRpcEventSource({
    rpcUrl: STELLAR_RPC_URL,
    contractId: contractIds,
  });

  let db;
  try {
    db = await getDb();
  } catch (err) {
    console.error('[indexer] DB connection failed:', err);
    return NextResponse.json(
      { error: 'Database unavailable' },
      { status: 503 }
    );
  }

  try {
    const result = await runIndexerBatch({
      db,
      eventSource,
      source: 'stellar',
      limit: BATCH_LIMIT,
    });

    console.log(
      `[indexer] batch complete — applied:${result.applied} skipped:${result.skipped} cursor:${result.nextCursor}`
    );

    return NextResponse.json({
      ok: true,
      applied: result.applied,
      skipped: result.skipped,
      nextCursor: result.nextCursor,
    });
  } catch (err) {
    console.error('[indexer] batch error:', err);
    return NextResponse.json(
      { error: 'Indexer batch failed', detail: err.message },
      { status: 500 }
    );
  }
}

/**
 * GET /api/indexer — return current sync cursor state for monitoring.
 */
export async function GET(request) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const db = await getDb();
    const state = await db
      .collection('sync_state')
      .findOne({ _id: 'stellar:events' });

    return NextResponse.json({
      synced: !!state,
      cursor: state?.cursor ?? null,
      lastLedger: state?.lastLedger ?? null,
      updatedAt: state?.updatedAt ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read sync state' },
      { status: 500 }
    );
  }
}

/**
 * Unified entitlement authorization service — Issue #470
 *
 * This is the single policy boundary every protected download / access route
 * must call to decide whether a wallet holds a usable entitlement for a
 * material. It replaces the several divergent, ad-hoc checks that used to
 * live directly in route handlers (raw cache reads, a mocked indexer stub,
 * bespoke purchases-DB lookups) with one authority that:
 *
 *   - Returns one of four explicit states: FINALIZED, PROVISIONAL, REVOKED,
 *     UNAVAILABLE (plus NOT_ENTITLED for the plain "never purchased" case).
 *     Only FINALIZED and PROVISIONAL grant access — every other outcome,
 *     including any internal error, denies.
 *   - Binds the decision to wallet address, material id, purchase id,
 *     network, contract id, and content hash so a cached decision minted
 *     under different chain/content configuration is never trusted.
 *   - Uses a bounded (TTL-limited) cache. Nothing is trusted forever; on
 *     expiry the decision is re-derived from the purchases collection and,
 *     where reachable, the chain. A REVOKED decision is written back
 *     immediately (event-driven invalidation) so refunds/disputes/expiry
 *     take effect without waiting for the TTL.
 *   - Fails closed: RPC, cache, or database errors produce UNAVAILABLE
 *     (deny), never a default allow.
 *
 * For full design documentation, state descriptions, decision diagrams, and
 * troubleshooting workflows, see docs/entitlement-authorization.md.
 */

// Relative imports throughout this file, deliberately — src/lib/purchases/access.js
// imports back from here, and that module is exercised directly by the
// tests/backend/*.mjs suite under plain `node --test` (no bundler, so the
// "@/..." alias doesn't resolve there).
import {
  Contract,
  Address,
  nativeToScVal,
  xdr,
  scValToNative,
  TransactionBuilder,
  Account,
  Networks,
} from '@stellar/stellar-sdk';
import {
  PURCHASE_MANAGER_CONTRACT_ID,
  STELLAR_RPC_URL,
  NETWORK_PASSPHRASE,
} from './config/chain.js';
import { isCompletedPurchaseStatus, normalizeBuyerAddress } from './purchases/access.js';
import logger from './logger.js';

// Imported lazily (not as a static top-level import) so callers that always
// supply their own `db` — the indexer processing a batch with an in-memory
// fake, for instance — never force the real MongoDB module to be loaded.
async function getDb() {
  const mod = await import('./mongodb.js');
  return mod.getDb();
}

export const ENTITLEMENT_STATE = Object.freeze({
  FINALIZED: 'finalized',
  PROVISIONAL: 'provisional',
  REVOKED: 'revoked',
  UNAVAILABLE: 'unavailable',
  NOT_ENTITLED: 'not_entitled',
});

// States that are allowed to serve a download. Everything else denies.
const ALLOWING_STATES = new Set([ENTITLEMENT_STATE.FINALIZED, ENTITLEMENT_STATE.PROVISIONAL]);

// Settlement states that mean the buyer no longer holds a usable entitlement.
const REVOKING_SETTLEMENT_STATES = new Set(['Refunded', 'Disputed', 'Expired']);

// Bounded cache window — nothing is trusted past this without re-derivation.
export const ENTITLEMENT_CACHE_TTL_MS = Number(process.env.ENTITLEMENT_CACHE_TTL_MS || 30_000);

// Cache versioning — increment on canonical chain events to invalidate stale entries.
export const CACHE_VERSION = Number(process.env.CACHE_VERSION || 1);

const CURRENT_NETWORK = NETWORK_PASSPHRASE;
const CURRENT_CONTRACT = PURCHASE_MANAGER_CONTRACT_ID || null;

function now() {
  return new Date();
}

function contentHashOf(material) {
  return (
    material?.ipfsCid ??
    material?.cid ??
    material?.fileHash ??
    material?.storageKey ??
    material?.fileUrl ??
    null
  );
}

// ── Chain access (best-effort; unreachable/unconfigured RPC never throws) ──

async function checkChainEntitlement(materialId, buyerAddress) {
  if (!PURCHASE_MANAGER_CONTRACT_ID || !STELLAR_RPC_URL) return null;

  try {
    const xdrTx = buildHasEntitlementXdr(materialId, buyerAddress);
    if (!xdrTx) return null;

    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: { transaction: xdrTx },
    };

    const res = await fetch(STELLAR_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });

    const payload = await res.json();
    if (payload.error) return null;

    const retval = payload.result?.results?.[0]?.xdr;
    if (!retval) return null;

    return decodeBoolean(retval);
  } catch {
    return null;
  }
}

/**
 * Check the on-chain settlement state for a purchase.
 * Returns the settlement state string or null if unavailable.
 *
 * Settlement states: Pending, Released, Disputed, Refunded, Expired
 */
async function checkChainSettlementState(purchaseId) {
  if (!PURCHASE_MANAGER_CONTRACT_ID || !STELLAR_RPC_URL || !purchaseId) return null;

  try {
    const xdrTx = buildSettlementStateXdr(purchaseId);
    if (!xdrTx) return null;

    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: { transaction: xdrTx },
    };

    const res = await fetch(STELLAR_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });

    const payload = await res.json();
    if (payload.error) return null;

    const retval = payload.result?.results?.[0]?.xdr;
    if (!retval) return null;

    return decodeSettlementState(retval);
  } catch {
    return null;
  }
}

export function buildHasEntitlementXdr(materialId, buyerAddress) {
  if (!PURCHASE_MANAGER_CONTRACT_ID || !materialId || !buyerAddress) return '';
  try {
    const contract = new Contract(PURCHASE_MANAGER_CONTRACT_ID);

    let materialBytes;
    if (typeof materialId === 'string') {
      const clean = materialId.startsWith('0x') ? materialId.slice(2) : materialId;
      if (/^[0-9a-fA-F]{64}$/.test(clean)) {
        materialBytes = Buffer.from(clean, 'hex');
      } else {
        materialBytes = Buffer.alloc(32);
        Buffer.from(materialId).copy(materialBytes);
      }
    } else if (Buffer.isBuffer(materialId) || materialId instanceof Uint8Array) {
      materialBytes = Buffer.from(materialId);
    } else {
      materialBytes = Buffer.alloc(32);
    }

    const materialScVal = nativeToScVal(materialBytes, { type: 'bytes' });
    const buyerScVal = new Address(buyerAddress).toScVal();
    const op = contract.call('has_entitlement', materialScVal, buyerScVal);

    const dummySource = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');
    const tx = new TransactionBuilder(dummySource, {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE || Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    return tx.toXDR();
  } catch (err) {
    logger.warn({ event: 'build_has_entitlement_xdr_failed', err: err?.message }, 'Failed to build has_entitlement XDR');
    return '';
  }
}

export function buildSettlementStateXdr(purchaseId) {
  if (!PURCHASE_MANAGER_CONTRACT_ID || purchaseId === null || purchaseId === undefined) return '';
  try {
    const contract = new Contract(PURCHASE_MANAGER_CONTRACT_ID);
    const purchaseIdBigInt = BigInt(purchaseId);
    const purchaseIdScVal = nativeToScVal(purchaseIdBigInt, { type: 'u64' });
    const op = contract.call('get_settlement_state', purchaseIdScVal);

    const dummySource = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');
    const tx = new TransactionBuilder(dummySource, {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE || Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    return tx.toXDR();
  } catch (err) {
    logger.warn({ event: 'build_settlement_state_xdr_failed', err: err?.message }, 'Failed to build settlement_state XDR');
    return '';
  }
}

export function decodeBoolean(xdrBase64) {
  if (!xdrBase64 || typeof xdrBase64 !== 'string') return null;
  try {
    const scVal = xdr.ScVal.fromXDR(xdrBase64, 'base64');
    const native = scValToNative(scVal);
    return typeof native === 'boolean' ? native : null;
  } catch {
    return null;
  }
}

export function decodeSettlementState(xdrBase64) {
  if (!xdrBase64 || typeof xdrBase64 !== 'string') return null;
  try {
    const scVal = xdr.ScVal.fromXDR(xdrBase64, 'base64');
    const native = scValToNative(scVal);
    const validStates = ['Pending', 'Released', 'Disputed', 'Refunded', 'Expired'];

    if (typeof native === 'string' && validStates.includes(native)) {
      return native;
    }
    if (typeof native === 'number' && native >= 0 && native < validStates.length) {
      return validStates[native];
    }
    if (native && typeof native === 'object') {
      const tag = native.tag || native.name || (typeof native.state === 'string' ? native.state : null);
      if (typeof tag === 'string' && validStates.includes(tag)) {
        return tag;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Cache primitives ────────────────────────────────────────────────────────

async function getCacheEntry(db, materialId, buyerAddress) {
  return db.collection('entitlement_cache').findOne({ materialId, buyerAddress });
}

async function writeCacheEntry(db, { materialId, buyerAddress, state, source, purchaseId, settlementState, network, contractId, contentHash }, session = null) {
  const timestamp = now();
  const active = ALLOWING_STATES.has(state);
  const options = session ? { upsert: true, session } : { upsert: true };
  const version = CACHE_VERSION;

  await db.collection('entitlement_cache').updateOne(
    { materialId, buyerAddress },
    {
      $set: {
        materialId,
        buyerAddress,
        state,
        active,
        source,
        purchaseId: purchaseId ?? null,
        settlementState: settlementState ?? null,
        network: network ?? CURRENT_NETWORK ?? null,
        contractId: contractId ?? CURRENT_CONTRACT,
        contentHash: contentHash ?? null,
        // Cache version — increment on canonical chain events to invalidate
        // stale entries across reorgs and network switches.
        cacheVersion: version,
        checkedAt: timestamp,
        updatedAt: timestamp,
      },
      $setOnInsert: { createdAt: timestamp },
    },
    options
  );

  return { state, active, source };
}

function isFresh(entry) {
  if (!entry?.checkedAt) return false;
  const checkedAt = entry.checkedAt instanceof Date ? entry.checkedAt : new Date(entry.checkedAt);
  const entryVersion = entry.cacheVersion ?? 0;
  const currentVersion = CACHE_VERSION;
  // Entry is fresh only if within TTL AND version matches current cache version
  // (version increments on canonical chain events, so stale versions are rejected).
  const isWithinTtl = Date.now() - checkedAt.getTime() < ENTITLEMENT_CACHE_TTL_MS;
  const versionMatches = entryVersion >= currentVersion;
  return isWithinTtl && versionMatches;
}

function bindingMatches(entry, { contentHash }) {
  if (entry.contractId && CURRENT_CONTRACT && entry.contractId !== CURRENT_CONTRACT) return false;
  if (entry.network && CURRENT_NETWORK && entry.network !== CURRENT_NETWORK) return false;
  if (entry.contentHash && contentHash && entry.contentHash !== contentHash) return false;
  return true;
}

function logDisagreement(context, detail) {
  try {
    logger.warn({ event: 'entitlement_disagreement', ...context, ...detail }, 'entitlement source disagreement detected');
  } catch {
  }
}

export async function invalidateEntitlement(materialId, buyerAddress, reason = 'revoked', extra = {}) {
  if (!materialId || !buyerAddress) return { success: false };

  const db = extra.db || (await getDb());
  const normalised = normalizeBuyerAddress(buyerAddress);

  await writeCacheEntry(
    db,
    {
      materialId,
      buyerAddress: normalised,
      state: ENTITLEMENT_STATE.REVOKED,
      source: reason,
      purchaseId: extra.purchaseId ?? null,
      settlementState: extra.settlementState ?? null,
    },
    extra.session || null
  );

  return { success: true };
}

/**
 * Create/refresh an entitlement record after a successful purchase.
 * Writes to the entitlement_cache collection for fast subsequent lookups.
 *
 * @param {string} materialId - The material identifier
 * @param {string} buyerAddress - The buyer's Stellar public key
 * @param {object} [purchaseData] - Optional purchase metadata to store
 * @returns {Promise<{success: boolean, source: string}>}
 */
export async function createEntitlement(materialId, buyerAddress, purchaseData = {}) {
  if (!materialId || !buyerAddress) {
    return { success: false, source: 'invalid-params' };
  }

  const db = await getDb();
  const normalised = normalizeBuyerAddress(buyerAddress);

  await writeCacheEntry(db, {
    materialId,
    buyerAddress: normalised,
    state: ENTITLEMENT_STATE.PROVISIONAL,
    source: 'purchase-api',
    purchaseId: purchaseData.purchaseId || null,
    settlementState: 'Pending',
    contentHash: purchaseData.contentHash || null,
  });

  // Preserve legacy fields historically read directly off entitlement_cache
  // (transaction hash / amount / asset) alongside the new policy fields.
  await db.collection('entitlement_cache').updateOne(
    { materialId, buyerAddress: normalised },
    {
      $set: {
        transactionHash: purchaseData.transactionHash || null,
        amount: purchaseData.amount || null,
        asset: purchaseData.asset || null,
      },
    }
  );

  return { success: true, source: 'purchase-api' };
}

/**
 * Revoke (deactivate) an entitlement — e.g. after a refund.
 *
 * @param {string} materialId - The material identifier
 * @param {string} buyerAddress - The buyer's wallet address
 * @returns {Promise<{success: boolean}>}
 */
export async function revokeEntitlement(materialId, buyerAddress) {
  return invalidateEntitlement(materialId, buyerAddress, 'refunded', { settlementState: 'Refunded' });
}

async function lookupBuyerSuspended(db, buyerAddress) {
  try {
    const user = await db.collection('users').findOne({ walletAddressLower: buyerAddress });
    return user?.status === 'suspended';
  } catch {
    // A suspension-lookup failure must not itself grant access, but it also
    // shouldn't take down every download for a DB hiccup on a side table —
    // treat as "not confirmed suspended" and let the primary entitlement
    // check (which fails closed on its own errors) carry the decision.
    return false;
  }
}

/**
 * The single policy boundary for "does this wallet hold a usable
 * entitlement for this material" — every protected route should resolve
 * access through this function (directly or via {@link authorizeMaterialAccess}).
 *
 * Binds the decision to wallet address, material id, purchase id, network,
 * contract id, and content hash. Fails closed on any internal error.
 *
 * Design note on caching: the purchases collection is always read fresh —
 * it's a cheap local lookup, and it's the one place a refund/dispute/expiry
 * lands regardless of which path recorded it (explicit API action or
 * indexer chain event), so a revoking settlement state there is honored
 * immediately, never gated by a TTL. A REVOKED verdict recorded directly in
 * entitlement_cache (event-driven invalidation) is treated the same way —
 * sticky and authoritative — because revocation is terminal in this domain
 * (refunded/disputed/expired purchases don't un-revoke themselves). The
 * bounded TTL cache exists only to avoid re-hitting the chain RPC on every
 * request for an *allowing* decision; it can never be the reason a download
 * is served.
 */
export async function resolveEntitlement({ db, materialId, buyerAddress, purchaseId = null, contentHash = null } = {}) {
  if (!materialId || !buyerAddress) {
    return { state: ENTITLEMENT_STATE.UNAVAILABLE, hasAccess: false, source: 'invalid-params' };
  }

  const normalised = normalizeBuyerAddress(buyerAddress);

  try {
    const database = db || (await getDb());

    if (await lookupBuyerSuspended(database, normalised)) {
      return { state: ENTITLEMENT_STATE.REVOKED, hasAccess: false, source: 'buyer-suspended' };
    }

    let purchase;
    try {
      purchase = await database.collection('purchases').findOne({ materialId, buyerAddress: normalised });
    } catch (err) {
      logger.warn({ event: 'entitlement_resolve_error', materialId, buyerAddress: normalised, err: err?.message }, 'purchases lookup failed closed');
      return { state: ENTITLEMENT_STATE.UNAVAILABLE, hasAccess: false, source: 'purchases-db-error' };
    }

    // A sticky, event-driven revocation always wins, however it was
    // recorded and regardless of cache age — see design note above.
    const cached = await getCacheEntry(database, materialId, normalised);
    if (cached?.state === ENTITLEMENT_STATE.REVOKED) {
      return { state: ENTITLEMENT_STATE.REVOKED, hasAccess: false, source: cached.source || 'cache' };
    }

    if (!purchase) {
      // No local record. Fall back to a direct on-chain entitlement check —
      // covers indexer lag where the buyer paid on-chain before the local
      // purchases collection caught up. An unreachable/unconfigured chain
      // never upgrades this to an allow; absence of evidence is not access.
      const onChain = await checkChainEntitlement(materialId, normalised);
      if (onChain === true) {
        await writeCacheEntry(database, {
          materialId,
          buyerAddress: normalised,
          state: ENTITLEMENT_STATE.FINALIZED,
          source: 'chain',
          purchaseId,
          settlementState: 'Released',
          contentHash,
        });
        return { state: ENTITLEMENT_STATE.FINALIZED, hasAccess: true, source: 'chain', purchaseId };
      }
      return { state: ENTITLEMENT_STATE.NOT_ENTITLED, hasAccess: false, source: 'not-found' };
    }

    if (!isCompletedPurchaseStatus(purchase.status)) {
      return { state: ENTITLEMENT_STATE.NOT_ENTITLED, hasAccess: false, source: 'purchases-db-incomplete' };
    }

    const effectivePurchaseId = purchaseId || purchase.purchaseId || null;

    // The purchase itself is the authoritative local record of settlement
    // state — checked fresh on every call, never TTL-gated, so a refund or
    // dispute mirrored here (by the refund route or an indexer event) is
    // honored immediately.
    if (purchase.settlementState && REVOKING_SETTLEMENT_STATES.has(purchase.settlementState)) {
      return {
        state: ENTITLEMENT_STATE.REVOKED,
        hasAccess: false,
        source: 'purchases-db',
        settlementState: purchase.settlementState,
      };
    }

    // Not known to be revoked. The entitlement_cache TTL only bounds how
    // long we trust a prior *allowing* verdict before re-checking chain.
    if (
      cached &&
      isFresh(cached) &&
      ALLOWING_STATES.has(cached.state) &&
      cached.purchaseId === effectivePurchaseId &&
      bindingMatches(cached, { contentHash })
    ) {
      return { state: cached.state, hasAccess: true, source: 'cache', purchaseId: effectivePurchaseId };
    }

    let settlementState = purchase.settlementState || null;
    const chainState = await checkChainSettlementState(effectivePurchaseId);

    // Deny-safe reorg handling:
    // - If chain state is available and differs from purchase state, log disagreement
    // - If chain state is unavailable (e.g. RPC outage), do NOT upgrade from local
    //   purchase state — keep the locally-recorded settlementState as-is.
    // - This prevents cache outages or reorgs from unexpectedly granting access.
    if (chainState && chainState !== settlementState) {
      logDisagreement(
        { materialId, buyerAddress: normalised },
        { purchasesDbSettlementState: settlementState, chainSettlementState: chainState }
      );
    }
    // Only upgrade settlementState from chain if chain state is available and
    // matches or supersedes the purchase state. If chain is unreachable, keep the
    // local purchase state to avoid granting access during reorg/outage.
    if (chainState) settlementState = chainState;

    if (settlementState && REVOKING_SETTLEMENT_STATES.has(settlementState)) {
      await writeCacheEntry(database, {
        materialId,
        buyerAddress: normalised,
        state: ENTITLEMENT_STATE.REVOKED,
        source: 'chain',
        purchaseId: effectivePurchaseId,
        settlementState,
      });
      try {
        await database
          .collection('purchases')
          .updateOne({ materialId, buyerAddress: normalised }, { $set: { settlementState, updatedAt: now() } });
      } catch {
        // Best-effort mirror; the cache write above already made the
        // revocation authoritative for subsequent calls.
      }
      return { state: ENTITLEMENT_STATE.REVOKED, hasAccess: false, source: 'chain', settlementState };
    }

    // Completed, non-revoked purchase. Chain-confirmed (Pending/Released) is
    // FINALIZED; an unreachable/unconfigured chain still grants bounded
    // access from the completed local purchase record, but only as
    // PROVISIONAL, and only until the cache TTL forces the next re-check.
    const state = chainState ? ENTITLEMENT_STATE.FINALIZED : ENTITLEMENT_STATE.PROVISIONAL;
    const source = chainState ? 'chain' : 'purchases-db';

    await writeCacheEntry(database, {
      materialId,
      buyerAddress: normalised,
      state,
      source,
      purchaseId: effectivePurchaseId,
      settlementState,
      contentHash,
    });

    return { state, hasAccess: true, source, purchaseId: effectivePurchaseId };
  } catch (err) {
    logger.warn({ event: 'entitlement_resolve_error', materialId, buyerAddress: normalised, err: err?.message }, 'entitlement resolution failed closed');
    return { state: ENTITLEMENT_STATE.UNAVAILABLE, hasAccess: false, source: 'error' };
  }
}

/**
 * Backward-compatible wrapper preserving the historical
 * `{ hasAccess, source }` shape relied on by non-download callers
 * (e.g. /api/entitlements).
 */
export async function verifyEntitlement(materialId, buyerAddress) {
  const result = await resolveEntitlement({ materialId, buyerAddress });
  return { hasAccess: result.hasAccess, source: result.source };
}

function isOwner(material, buyerAddress) {
  const buyer = normalizeBuyerAddress(buyerAddress);
  return [material?.userAddress, material?.ownerAddress, material?.creatorAddress]
    .filter(Boolean)
    .some((address) => normalizeBuyerAddress(address) === buyer);
}

function isFreePublicMaterial(material) {
  const price = Number(material?.price || 0);
  return price <= 0 && material?.visibility === 'public';
}

/**
 * High-level policy boundary for material access/download routes.
 *
 * Resolves ownership and free-public bypasses, then falls through to
 * {@link resolveEntitlement} for purchased materials. A missing `material`
 * (orphaned reference / not found) always denies (UNAVAILABLE) — callers
 * are expected to look the material up themselves so they can also 404.
 *
 * @returns {Promise<{allowed: boolean, state: string, httpStatus: number, source: string}>}
 */
export async function authorizeMaterialAccess({ db, material, buyerAddress, purchaseId = null } = {}) {
  if (!material) {
    return { allowed: false, state: ENTITLEMENT_STATE.UNAVAILABLE, httpStatus: 404, source: 'orphaned' };
  }
  if (!buyerAddress) {
    return { allowed: false, state: ENTITLEMENT_STATE.UNAVAILABLE, httpStatus: 400, source: 'missing-buyer' };
  }

  if (isOwner(material, buyerAddress)) {
    return { allowed: true, state: ENTITLEMENT_STATE.FINALIZED, httpStatus: 200, source: 'owner' };
  }

  if (isFreePublicMaterial(material)) {
    return { allowed: true, state: ENTITLEMENT_STATE.FINALIZED, httpStatus: 200, source: 'free-public' };
  }

  const result = await resolveEntitlement({
    db,
    materialId: material.materialId || String(material._id),
    buyerAddress,
    purchaseId,
    contentHash: contentHashOf(material),
  });

  const httpStatus = result.hasAccess ? 200 : result.state === ENTITLEMENT_STATE.UNAVAILABLE ? 503 : 403;

  return {
    allowed: result.hasAccess,
    state: result.state,
    httpStatus,
    source: result.source,
  };
}

export function requireEntitlement(handler, getMaterialId) {
  return async function protectedHandler(request, context) {
    const { searchParams } = new URL(request.url);
    const buyerAddress = searchParams.get('buyerAddress') ?? '';
    const materialId =
      typeof getMaterialId === 'function'
        ? getMaterialId(request, context)
        : searchParams.get('materialId') ?? '';

    if (!buyerAddress || !materialId) {
      const { NextResponse } = await import('next/server');
      return NextResponse.json({ error: 'Missing buyerAddress or materialId' }, { status: 400 });
    }

    const { hasAccess, source } = await verifyEntitlement(materialId, buyerAddress);

    if (!hasAccess) {
      const { NextResponse } = await import('next/server');
      return NextResponse.json(
        {
          error: 'Unlicensed Access',
          detail: 'You do not hold an active entitlement for this material. Please purchase it first.',
        },
        { status: 403 }
      );
    }

    return handler(request, context, { materialId, buyerAddress, source });
  };
}// Issue 425: Verification of access rights before download implemented

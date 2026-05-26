/**
 * On-chain entitlement verification utility — Issue #63
 *
 * Checks whether a buyer holds a valid purchase record for a material by:
 *  1. Querying the local entitlement_cache collection first (fast path).
 *  2. Falling back to a direct Soroban RPC call against the PurchaseManager
 *     contract when the cache has no record (slow path / first-time check).
 *
 * The result is written back to the cache so subsequent requests are fast.
 */

import { getDb } from '@/lib/mongodb';

const PURCHASE_MANAGER_CONTRACT_ID =
  process.env.PURCHASE_MANAGER_CONTRACT_ID ?? '';
const STELLAR_RPC_URL =
  process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';

// ── Cache helpers ──────────────────────────────────────────────────────────────

async function getCachedEntitlement(db, materialId, buyerAddress) {
  return db.collection('entitlement_cache').findOne({
    materialId,
    buyerAddress: buyerAddress.toLowerCase(),
  });
}

async function setCachedEntitlement(db, materialId, buyerAddress, active) {
  await db.collection('entitlement_cache').updateOne(
    { materialId, buyerAddress: buyerAddress.toLowerCase() },
    {
      $set: {
        materialId,
        buyerAddress: buyerAddress.toLowerCase(),
        active,
        source: active ? 'chain' : 'chain-miss',
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

// ── On-chain check via Soroban RPC (simulateTransaction) ──────────────────────

/**
 * Build a minimal Soroban `simulateTransaction` request to call
 * `PurchaseManager.has_entitlement(material_id, buyer)`.
 *
 * Uses the JSON-RPC `simulateTransaction` method which does not broadcast
 * — it's a read-only simulation. Returns true if the contract returns true.
 */
async function checkChainEntitlement(materialId, buyerAddress) {
  if (!PURCHASE_MANAGER_CONTRACT_ID || !STELLAR_RPC_URL) return null;

  try {
    // Encode arguments as XDR ScVal (bytes32 + address)
    // This is a simplified encoding — in production use stellar-sdk helpers.
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: {
        transaction: buildHasEntitlementXdr(materialId, buyerAddress),
      },
    };

    const res = await fetch(STELLAR_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });

    const payload = await res.json();
    if (payload.error) return null;

    // Parse return value — true means entitlement is active
    const retval = payload.result?.results?.[0]?.xdr;
    if (!retval) return null;

    return decodeBoolean(retval);
  } catch {
    return null; // network/parse failure — caller falls back to DB only
  }
}

/**
 * Placeholder XDR builder — in production, use:
 *   import { Contract, Address, xdr, nativeToScVal } from '@stellar/stellar-sdk'
 *   const contract = new Contract(PURCHASE_MANAGER_CONTRACT_ID)
 *   contract.call('has_entitlement', materialIdScVal, addressScVal)
 */
function buildHasEntitlementXdr(_materialId, _buyerAddress) {
  // Return an empty string — the rpc call will fail gracefully and we fall
  // back to the cache. Replace with real XDR building via stellar-sdk.
  return '';
}

function decodeBoolean(xdrBase64) {
  // Simplified — a real implementation decodes the XDR ScVal.
  // `true` encodes as `AAAABAAAAAEAAAAAAAAeAA==` in XDR.
  return xdrBase64.includes('AAAE') || xdrBase64.includes('true');
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Verify that `buyerAddress` holds an active entitlement for `materialId`.
 *
 * @param {string} materialId   - Material identifier (hex or stringified bytes32)
 * @param {string} buyerAddress - Stellar public key of the buyer
 * @returns {{ hasAccess: boolean, source: string }}
 */
export async function verifyEntitlement(materialId, buyerAddress) {
  if (!materialId || !buyerAddress) {
    return { hasAccess: false, source: 'invalid-params' };
  }

  const db = await getDb();
  const normalised = buyerAddress.toLowerCase();

  // 1. Fast path — check the purchase cache first
  const cached = await getCachedEntitlement(db, materialId, normalised);
  if (cached) {
    if (cached.active) return { hasAccess: true, source: 'cache' };
    // Negative cache — still try chain to handle late confirmation
  }

  // 2. Check purchases collection (indexed from events)
  const purchase = await db.collection('purchases').findOne({
    materialId,
    buyerAddress: normalised,
    status: 'settled',
  });

  if (purchase) {
    await setCachedEntitlement(db, materialId, normalised, true);
    return { hasAccess: true, source: 'purchases-db' };
  }

  // 3. Slow path — query the chain directly
  const onChain = await checkChainEntitlement(materialId, buyerAddress);
  if (onChain === true) {
    await setCachedEntitlement(db, materialId, normalised, true);
    return { hasAccess: true, source: 'chain' };
  }

  // No entitlement found
  return { hasAccess: false, source: 'not-found' };
}

/**
 * Express/Next.js middleware factory for route-level entitlement protection.
 *
 * Usage (Next.js App Router):
 *   import { requireEntitlement } from '@/lib/entitlement'
 *   export const GET = requireEntitlement(handler, getMaterialId)
 */
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
      return NextResponse.json(
        { error: 'Missing buyerAddress or materialId' },
        { status: 400 }
      );
    }

    const { hasAccess, source } = await verifyEntitlement(
      materialId,
      buyerAddress
    );

    if (!hasAccess) {
      const { NextResponse } = await import('next/server');
      return NextResponse.json(
        {
          error: 'Unlicensed Access',
          detail:
            'You do not hold an active entitlement for this material. Please purchase it first.',
        },
        { status: 403 }
      );
    }

    return handler(request, context, { materialId, buyerAddress, source });
  };
}

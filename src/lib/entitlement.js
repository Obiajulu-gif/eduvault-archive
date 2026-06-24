import { getDb } from '@/lib/mongodb';
import { PURCHASE_MANAGER_CONTRACT_ID, STELLAR_RPC_URL } from '@/lib/config/chain';
import { isCompletedPurchaseStatus, normalizeBuyerAddress } from '@/lib/purchases/access';

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

async function checkChainEntitlement(materialId, buyerAddress) {
  if (!PURCHASE_MANAGER_CONTRACT_ID || !STELLAR_RPC_URL) return null;

  try {
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

    const retval = payload.result?.results?.[0]?.xdr;
    if (!retval) return null;

    return decodeBoolean(retval);
  } catch {
    return null;
  }
}

function buildHasEntitlementXdr(_materialId, _buyerAddress) {
  return '';
}

function decodeBoolean(xdrBase64) {
  return xdrBase64.includes('AAAE') || xdrBase64.includes('true');
}

export async function verifyEntitlement(materialId, buyerAddress) {
  if (!materialId || !buyerAddress) {
    return { hasAccess: false, source: 'invalid-params' };
  }

  const db = await getDb();
  const normalised = normalizeBuyerAddress(buyerAddress);

  const cached = await getCachedEntitlement(db, materialId, normalised);
  if (cached) {
    if (cached.active) return { hasAccess: true, source: 'cache' };
  }

  const purchase = await db.collection('purchases').findOne({
    materialId,
    buyerAddress: normalised,
  });

  if (purchase && isCompletedPurchaseStatus(purchase.status)) {
    await setCachedEntitlement(db, materialId, normalised, true);
    return { hasAccess: true, source: 'purchases-db' };
  }

  const onChain = await checkChainEntitlement(materialId, buyerAddress);
  if (onChain === true) {
    await setCachedEntitlement(db, materialId, normalised, true);
    return { hasAccess: true, source: 'chain' };
  }

  return { hasAccess: false, source: 'not-found' };
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

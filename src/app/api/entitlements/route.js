export const dynamic = "force-dynamic";

import { NextResponse } from 'next/server'
import { verifyEntitlement } from '@/lib/entitlement'
import { renderProblemResponse } from '@/lib/errors/renderErrorResponse.js'
import { captureException } from '@/lib/sentry'

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url)
    const buyerAddress = searchParams.get('buyerAddress')
    const materialId = searchParams.get('materialId')

    if (!buyerAddress || !materialId) {
      return renderProblemResponse("VALIDATION_FIELD", req, "Missing buyerAddress or materialId")
    }

    const { hasAccess, source } = await verifyEntitlement(materialId, buyerAddress)

    return NextResponse.json(
      { hasAccess, source },
      { status: 200 }
    )
  } catch (error) {
    captureException(error, { route: "entitlements", method: "GET" })
    return renderProblemResponse("ENTITLEMENT_UNAVAILABLE", req, "Entitlement verification unavailable")
  }
}

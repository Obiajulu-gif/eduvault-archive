export const dynamic = "force-dynamic";

import { NextResponse } from 'next/server'
import { verifyEntitlement } from '@/lib/entitlement'

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url)
    const buyerAddress = searchParams.get('buyerAddress')
    const materialId = searchParams.get('materialId')

    if (!buyerAddress || !materialId) {
      return NextResponse.json(
        { error: 'Missing buyerAddress or materialId' },
        { status: 400 }
      )
    }

    const { hasAccess, source } = await verifyEntitlement(materialId, buyerAddress)

    return NextResponse.json(
      { hasAccess, source },
      { status: 200 }
    )
  } catch (error) {
    console.error('Entitlement Check Error:', error)
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    )
  }
}

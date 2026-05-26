export const dynamic = "force-dynamic";

import { getDb } from '@/lib/mongodb'
import { NextResponse } from 'next/server'

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

    const db = await getDb()

    const entitlement = await db
      .collection('purchases')
      .findOne({ buyerAddress, materialId })

    if (entitlement && entitlement.status === 'confirmed') {
      return NextResponse.json(
        { hasAccess: true, entitlement },
        { status: 200 }
      )
    } else {
      return NextResponse.json({ hasAccess: false }, { status: 200 })
    }
  } catch (error) {
    console.error('Entitlement Check Error:', error)
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    )
  }
}

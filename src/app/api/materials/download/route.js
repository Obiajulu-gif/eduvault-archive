import { getDb } from '@/lib/mongodb'
import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'

export async function GET(req, { params }) {
  try {
    const materialId = params.id
    const { searchParams } = new URL(req.url)
    const buyerAddress = searchParams.get('buyerAddress')

    if (!buyerAddress) {
      return NextResponse.json(
        { error: 'Missing buyer address for authorization' },
        { status: 401 }
      )
    }

    const db = await getDb()

    // 1. Find material
    const material = await db
      .collection('materials')
      .findOne({ _id: new ObjectId(materialId) })
    if (!material) {
      return NextResponse.json({ error: 'Material not found' }, { status: 404 })
    }

    // 2. Gate access (If it's not free and the user isn't the seller)
    if (material.price > 0 && material.sellerAddress !== buyerAddress) {
      const entitlement = await db.collection('purchases').findOne({
        buyerAddress,
        materialId,
      })

      if (!entitlement || entitlement.status !== 'confirmed') {
        return NextResponse.json(
          {
            error:
              'Access denied. No valid entitlement found. Please purchase the material first.',
          },
          { status: 403 }
        )
      }
    }

    // 3. Yield Protected Resource
    // In a full production app, you might proxy the file stream here or generate a temporary signed URL.
    // For this prototype, returning the CID / Gateway link acts as the delivery.
    return NextResponse.json(
      {
        success: true,
        downloadUrl: `https://gateway.pinata.cloud/ipfs/${material.cid}`,
        fileName: material.fileName,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error('Download Gate Error:', error)
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    )
  }
}

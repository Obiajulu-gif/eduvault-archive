import crypto from 'node:crypto'
import { ObjectId } from 'mongodb'

export const QUOTE_TTL_MS = 10 * 60 * 1000

export async function createCheckoutQuote(db, { materialId, buyerAddress, now = new Date(), ttlMs = QUOTE_TTL_MS }) {
  const query = ObjectId.isValid(materialId) ? { _id: new ObjectId(materialId) } : { materialId }
  const material = await db.collection('materials').findOne(query)
  if (!material || material.isDeleted || material.archived || material.visibility !== 'public') throw new Error('Material is not available for checkout.')
  const quote = {
    quoteId: crypto.randomUUID(), materialId: String(materialId), materialDocumentId: String(material._id ?? material.materialId), buyerAddress,
    terms: { price: material.price, asset: material.asset || material.assetCode || 'XLM', creatorAddress: material.userAddress || null, materialVersion: material.version || 1 },
    status: 'open', createdAt: now, expiresAt: new Date(now.getTime() + ttlMs),
  }
  await db.collection('checkout_quotes').insertOne(quote)
  return quote
}

export async function consumeCheckoutQuote(db, { quoteId, materialId, buyerAddress, now = new Date() }) {
  const result = await db.collection('checkout_quotes').findOneAndUpdate(
    { quoteId, materialId: String(materialId), buyerAddress, status: 'open', expiresAt: { $gt: now } },
    { $set: { status: 'consumed', consumedAt: now } },
    { returnDocument: 'after' },
  )
  const quote = result?.value || result
  if (!quote) {
    const existing = await db.collection('checkout_quotes').findOne({ quoteId })
    if (existing?.expiresAt <= now) throw Object.assign(new Error('Checkout quote expired. Refresh the listing to request a new quote.'), { code: 'QUOTE_EXPIRED' })
    throw Object.assign(new Error('Checkout quote is invalid or already used.'), { code: 'QUOTE_INVALID' })
  }
  return quote
}

import crypto from 'node:crypto'
import { ObjectId } from 'mongodb'
import { AppError } from '../errors/AppError.js'
import {
  QUOTE_TTL_MS,
  QUOTE_SIGNING_BUFFER_MS,
  STALE_QUOTE_REASONS,
} from './quoteConstants.js'

export { QUOTE_TTL_MS, QUOTE_SIGNING_BUFFER_MS, STALE_QUOTE_REASONS }

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase()
}

function buildMaterialTerms(material) {
  return {
    price: material.price,
    asset: material.asset || material.assetCode || 'XLM',
    creatorAddress: material.userAddress || null,
    materialVersion: material.version || 1,
  }
}

export function compareQuoteTerms(quoteTerms = {}, material) {
  const currentTerms = buildMaterialTerms(material)
  const changedFields = []

  if (Number(quoteTerms.price) !== Number(currentTerms.price)) {
    changedFields.push('price')
  }
  if (String(quoteTerms.asset || '').trim().toUpperCase() !== String(currentTerms.asset || '').trim().toUpperCase()) {
    changedFields.push('asset')
  }
  if (normalizeAddress(quoteTerms.creatorAddress) !== normalizeAddress(currentTerms.creatorAddress)) {
    changedFields.push('creatorAddress')
  }
  if (Number(quoteTerms.materialVersion || 1) !== Number(currentTerms.materialVersion || 1)) {
    changedFields.push('materialVersion')
  }

  return {
    matched: changedFields.length === 0,
    changedFields,
    quoteTerms: {
      price: quoteTerms.price,
      asset: quoteTerms.asset,
      creatorAddress: quoteTerms.creatorAddress ?? null,
      materialVersion: quoteTerms.materialVersion || 1,
    },
    currentTerms,
  }
}

export async function createCheckoutQuote(db, { materialId, buyerAddress, now = new Date(), ttlMs = QUOTE_TTL_MS }) {
  const query = ObjectId.isValid(materialId) ? { _id: new ObjectId(materialId) } : { materialId }
  const material = await db.collection('materials').findOne(query)
  if (material?.archived) throw new AppError('MATERIAL_ARCHIVED')
  if (!material || material.isDeleted || material.visibility !== 'public') throw new AppError('NOT_FOUND')
  const quote = {
    quoteId: crypto.randomUUID(), materialId: String(materialId), materialDocumentId: String(material._id ?? material.materialId), buyerAddress,
    terms: buildMaterialTerms(material),
    status: 'open', createdAt: now, expiresAt: new Date(now.getTime() + ttlMs),
  }
  await db.collection('checkout_quotes').insertOne(quote)
  return quote
}

/**
 * Non-consuming pre-signing freshness check for an existing checkout quote.
 * Verifies buyer authorization, quote lifecycle status, TTL (plus optional
 * signing safety buffer), material availability, and live pricing/terms drift
 * before the buyer is prompted to sign a wallet transaction.
 */
export async function validateCheckoutQuote(
  db,
  { quoteId, materialId, buyerAddress, now = new Date(), minRemainingMs = 0 },
) {
  const checkedAt = now instanceof Date ? now : new Date(now)
  const safeBufferMs = Math.max(0, Number(minRemainingMs) || 0)

  const quote = await db.collection('checkout_quotes').findOne({ quoteId })
  if (!quote) {
    return {
      fresh: false,
      stale: true,
      authorized: true,
      canRefresh: true,
      reason: STALE_QUOTE_REASONS.QUOTE_NOT_FOUND,
      checkedAt,
    }
  }

  if (normalizeAddress(quote.buyerAddress) !== normalizeAddress(buyerAddress)) {
    return {
      fresh: false,
      stale: true,
      authorized: false,
      canRefresh: true,
      reason: STALE_QUOTE_REASONS.BUYER_MISMATCH,
      checkedAt,
    }
  }

  if (materialId !== undefined && String(quote.materialId) !== String(materialId)) {
    return {
      fresh: false,
      stale: true,
      authorized: true,
      canRefresh: true,
      reason: STALE_QUOTE_REASONS.MATERIAL_MISMATCH,
      checkedAt,
    }
  }

  if (quote.status !== 'open') {
    return {
      fresh: false,
      stale: true,
      authorized: true,
      canRefresh: true,
      reason: STALE_QUOTE_REASONS.QUOTE_CONSUMED,
      checkedAt,
    }
  }

  const expiresAt = quote.expiresAt instanceof Date ? quote.expiresAt : new Date(quote.expiresAt)
  const remainingMs = expiresAt.getTime() - checkedAt.getTime()
  if (Number.isNaN(remainingMs) || remainingMs <= 0) {
    return {
      fresh: false,
      stale: true,
      authorized: true,
      canRefresh: true,
      reason: STALE_QUOTE_REASONS.QUOTE_EXPIRED,
      expiresAt,
      remainingMs: 0,
      checkedAt,
    }
  }

  if (safeBufferMs > 0 && remainingMs <= safeBufferMs) {
    return {
      fresh: false,
      stale: true,
      authorized: true,
      canRefresh: true,
      reason: STALE_QUOTE_REASONS.QUOTE_EXPIRING_SOON,
      expiresAt,
      remainingMs,
      checkedAt,
    }
  }

  const lookupId = quote.materialDocumentId || quote.materialId
  const query = ObjectId.isValid(lookupId) ? { _id: new ObjectId(lookupId) } : { materialId: String(lookupId) }
  const material = await db.collection('materials').findOne(query)

  if (material?.archived) {
    return {
      fresh: false,
      stale: true,
      authorized: true,
      canRefresh: false,
      reason: STALE_QUOTE_REASONS.MATERIAL_ARCHIVED,
      expiresAt,
      checkedAt,
    }
  }

  if (!material || material.isDeleted || material.visibility !== 'public') {
    return {
      fresh: false,
      stale: true,
      authorized: true,
      canRefresh: false,
      reason: STALE_QUOTE_REASONS.MATERIAL_UNAVAILABLE,
      expiresAt,
      checkedAt,
    }
  }

  const comparison = compareQuoteTerms(quote.terms, material)
  if (!comparison.matched) {
    return {
      fresh: false,
      stale: true,
      authorized: true,
      canRefresh: true,
      reason: STALE_QUOTE_REASONS.TERMS_CHANGED,
      changedFields: comparison.changedFields,
      quoteTerms: comparison.quoteTerms,
      currentTerms: comparison.currentTerms,
      expiresAt,
      remainingMs,
      checkedAt,
    }
  }

  return {
    fresh: true,
    stale: false,
    authorized: true,
    canRefresh: false,
    quote,
    currentTerms: comparison.currentTerms,
    expiresAt,
    remainingMs,
    checkedAt,
  }
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

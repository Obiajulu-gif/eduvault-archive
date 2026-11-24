import { describe, expect, it } from 'vitest'
import {
  consumeCheckoutQuote,
  createCheckoutQuote,
  STALE_QUOTE_REASONS,
  validateCheckoutQuote,
} from './quotes'

describe('checkout quote concurrency', () => {
  it('lets exactly one concurrent confirmation consume a live price snapshot', async () => {
    const quote = { quoteId: 'q1', materialId: 'm1', buyerAddress: 'buyer', status: 'open', expiresAt: new Date('2030-01-01'), terms: { price: 10 } }
    const collection = {
      async findOneAndUpdate(filter) {
        if (quote.status !== 'open' || !(quote.expiresAt > filter.expiresAt.$gt)) return null
        quote.status = 'consumed'
        return { ...quote }
      },
      async findOne() { return quote },
    }
    const db = { collection: () => collection }
    const results = await Promise.allSettled([
      consumeCheckoutQuote(db, { quoteId: 'q1', materialId: 'm1', buyerAddress: 'buyer', now: new Date('2029-01-01') }),
      consumeCheckoutQuote(db, { quoteId: 'q1', materialId: 'm1', buyerAddress: 'buyer', now: new Date('2029-01-01') }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('returns a clear re-quote error for expired snapshots', async () => {
    const expired = { quoteId: 'q1', expiresAt: new Date('2020-01-01') }
    const db = { collection: () => ({ findOneAndUpdate: async () => null, findOne: async () => expired }) }
    await expect(consumeCheckoutQuote(db, { quoteId: 'q1', materialId: 'm1', buyerAddress: 'buyer', now: new Date('2021-01-01') })).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
  })

  it('returns a stable not-found error for unavailable material', async () => {
    const db = { collection: () => ({ findOne: async () => null }) }
    await expect(createCheckoutQuote(db, { materialId: 'm1', buyerAddress: 'buyer' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
  })

  it('blocks checkout for archived material with a stable archived code', async () => {
    const db = { collection: () => ({ findOne: async () => ({ _id: 'm1', archived: true }) }) }
    await expect(createCheckoutQuote(db, { materialId: 'm1', buyerAddress: 'buyer' }))
      .rejects.toMatchObject({ code: 'MATERIAL_ARCHIVED', status: 410 })
  })
})

describe('validateCheckoutQuote (pre-signing freshness)', () => {
  function createMockDb({ quote, material }) {
    return {
      collection(name) {
        if (name === 'checkout_quotes') {
          return { findOne: async () => quote }
        }
        if (name === 'materials') {
          return { findOne: async () => material }
        }
        throw new Error(`Unexpected collection: ${name}`)
      },
    }
  }

  const baseNow = new Date('2026-11-24T12:00:00.000Z')
  const baseQuote = {
    quoteId: 'q-fresh',
    materialId: 'm1',
    materialDocumentId: 'm1',
    buyerAddress: 'gbuyer123',
    status: 'open',
    expiresAt: new Date('2026-11-24T12:10:00.000Z'),
    terms: {
      price: 25,
      asset: 'XLM',
      creatorAddress: 'gcreator1',
      materialVersion: 1,
    },
  }
  const baseMaterial = {
    materialId: 'm1',
    visibility: 'public',
    isDeleted: false,
    archived: false,
    price: 25,
    asset: 'XLM',
    userAddress: 'gcreator1',
    version: 1,
  }

  it('confirms a fresh quote without consuming it', async () => {
    const db = createMockDb({ quote: { ...baseQuote }, material: { ...baseMaterial } })
    const result = await validateCheckoutQuote(db, {
      quoteId: 'q-fresh',
      materialId: 'm1',
      buyerAddress: 'GBUYER123',
      now: baseNow,
      minRemainingMs: 15_000,
    })

    expect(result.fresh).toBe(true)
    expect(result.stale).toBe(false)
    expect(result.authorized).toBe(true)
    expect(result.remainingMs).toBe(10 * 60 * 1000)
  })

  it('detects expired quotes before signing', async () => {
    const db = createMockDb({
      quote: { ...baseQuote, expiresAt: new Date('2026-11-24T11:59:59.000Z') },
      material: { ...baseMaterial },
    })
    const result = await validateCheckoutQuote(db, {
      quoteId: 'q-fresh',
      materialId: 'm1',
      buyerAddress: 'gbuyer123',
      now: baseNow,
    })

    expect(result.fresh).toBe(false)
    expect(result.reason).toBe(STALE_QUOTE_REASONS.QUOTE_EXPIRED)
    expect(result.canRefresh).toBe(true)
  })

  it('detects quotes inside the signing safety buffer', async () => {
    const db = createMockDb({
      quote: { ...baseQuote, expiresAt: new Date('2026-11-24T12:00:10.000Z') },
      material: { ...baseMaterial },
    })
    const result = await validateCheckoutQuote(db, {
      quoteId: 'q-fresh',
      materialId: 'm1',
      buyerAddress: 'gbuyer123',
      now: baseNow,
      minRemainingMs: 15_000,
    })

    expect(result.fresh).toBe(false)
    expect(result.reason).toBe(STALE_QUOTE_REASONS.QUOTE_EXPIRING_SOON)
    expect(result.canRefresh).toBe(true)
  })

  it('rejects quotes belonging to a different buyer (authorization path)', async () => {
    const db = createMockDb({ quote: { ...baseQuote }, material: { ...baseMaterial } })
    const result = await validateCheckoutQuote(db, {
      quoteId: 'q-fresh',
      materialId: 'm1',
      buyerAddress: 'gotherbuyer',
      now: baseNow,
    })

    expect(result.fresh).toBe(false)
    expect(result.authorized).toBe(false)
    expect(result.reason).toBe(STALE_QUOTE_REASONS.BUYER_MISMATCH)
  })

  it('detects live price, asset, creator, or version drift', async () => {
    const db = createMockDb({
      quote: { ...baseQuote },
      material: { ...baseMaterial, price: 40, version: 2 },
    })
    const result = await validateCheckoutQuote(db, {
      quoteId: 'q-fresh',
      materialId: 'm1',
      buyerAddress: 'gbuyer123',
      now: baseNow,
    })

    expect(result.fresh).toBe(false)
    expect(result.reason).toBe(STALE_QUOTE_REASONS.TERMS_CHANGED)
    expect(result.changedFields).toEqual(['price', 'materialVersion'])
    expect(result.quoteTerms.price).toBe(25)
    expect(result.currentTerms.price).toBe(40)
    expect(result.canRefresh).toBe(true)
  })

  it('detects already-consumed quotes', async () => {
    const db = createMockDb({
      quote: { ...baseQuote, status: 'consumed' },
      material: { ...baseMaterial },
    })
    const result = await validateCheckoutQuote(db, {
      quoteId: 'q-fresh',
      materialId: 'm1',
      buyerAddress: 'gbuyer123',
      now: baseNow,
    })

    expect(result.fresh).toBe(false)
    expect(result.reason).toBe(STALE_QUOTE_REASONS.QUOTE_CONSUMED)
    expect(result.canRefresh).toBe(true)
  })

  it('detects archived and unavailable materials as non-refreshable', async () => {
    const archivedDb = createMockDb({
      quote: { ...baseQuote },
      material: { ...baseMaterial, archived: true },
    })
    const archivedRes = await validateCheckoutQuote(archivedDb, {
      quoteId: 'q-fresh',
      materialId: 'm1',
      buyerAddress: 'gbuyer123',
      now: baseNow,
    })
    expect(archivedRes.fresh).toBe(false)
    expect(archivedRes.reason).toBe(STALE_QUOTE_REASONS.MATERIAL_ARCHIVED)
    expect(archivedRes.canRefresh).toBe(false)

    const deletedDb = createMockDb({
      quote: { ...baseQuote },
      material: { ...baseMaterial, isDeleted: true },
    })
    const deletedRes = await validateCheckoutQuote(deletedDb, {
      quoteId: 'q-fresh',
      materialId: 'm1',
      buyerAddress: 'gbuyer123',
      now: baseNow,
    })
    expect(deletedRes.fresh).toBe(false)
    expect(deletedRes.reason).toBe(STALE_QUOTE_REASONS.MATERIAL_UNAVAILABLE)
    expect(deletedRes.canRefresh).toBe(false)
  })
})

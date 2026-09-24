import { describe, expect, it } from 'vitest'
import { consumeCheckoutQuote } from './quotes'

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
})

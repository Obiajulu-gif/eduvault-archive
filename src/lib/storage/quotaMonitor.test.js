import { describe, expect, it, vi } from 'vitest'
import { assertStorageCapacity, evaluateQuota, pollAndRecordQuota } from './quotaMonitor'

describe('storage quota monitoring', () => {
  it('records history and alerts before exhaustion', async () => {
    const insertOne = vi.fn()
    const alert = vi.fn()
    const db = { collection: () => ({ insertOne }) }
    const state = await pollAndRecordQuota({ db, fetchUsage: async () => ({ usedBytes: 85, limitBytes: 100 }), alert })
    expect(state.warning).toBe(true)
    expect(insertOne).toHaveBeenCalledOnce()
    expect(alert).toHaveBeenCalledOnce()
  })

  it('blocks before a partial upload when projected usage exceeds the plan', async () => {
    const db = { collection: () => ({ findOne: async () => ({ usedBytes: 95, limitBytes: 100 }) }) }
    await expect(assertStorageCapacity(db, 6)).rejects.toMatchObject({ status: 503 })
    expect(evaluateQuota({ usedBytes: 50, limitBytes: 100, uploadBytes: 10 }).healthy).toBe(true)
  })
})

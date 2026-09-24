export class StorageQuotaError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StorageQuotaError'
    this.status = 503
  }
}

export function evaluateQuota({ usedBytes, limitBytes, uploadBytes = 0, warningRatio = 0.8 }) {
  const projectedBytes = usedBytes + uploadBytes
  const ratio = limitBytes > 0 ? projectedBytes / limitBytes : 1
  return { usedBytes, limitBytes, projectedBytes, ratio, healthy: ratio < 1, warning: ratio >= warningRatio }
}

export async function pollAndRecordQuota({ db, fetchUsage, alert, now = new Date() }) {
  const usage = await fetchUsage()
  const snapshot = { ...evaluateQuota(usage), provider: 'pinata', checkedAt: now }
  await db.collection('storage_quota_history').insertOne(snapshot)
  if (snapshot.warning) await alert?.(snapshot)
  return snapshot
}

export async function assertStorageCapacity(db, uploadBytes) {
  const latest = await db.collection('storage_quota_history').findOne(
    { provider: 'pinata' },
    { sort: { checkedAt: -1 } },
  )
  if (!latest) return
  const state = evaluateQuota({ usedBytes: latest.usedBytes, limitBytes: latest.limitBytes, uploadBytes })
  if (!state.healthy) throw new StorageQuotaError('Storage capacity is temporarily exhausted. Your upload was not started; please try again later.')
}

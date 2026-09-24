import { NextResponse } from 'next/server'
import { getDb } from '@/lib/mongodb'
import { pollAndRecordQuota } from '@/lib/storage/quotaMonitor'

export async function POST(request) {
  if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const db = await getDb()
    const snapshot = await pollAndRecordQuota({
      db,
      fetchUsage: async () => {
        const response = await fetch(process.env.PINATA_USAGE_URL, {
          headers: { authorization: `Bearer ${process.env.PINATA_JWT}` },
          cache: 'no-store',
        })
        if (!response.ok) throw new Error(`Pinata usage request failed (${response.status})`)
        const usage = await response.json()
        return { usedBytes: Number(usage.usedBytes ?? usage.totalSize), limitBytes: Number(usage.limitBytes ?? usage.storageLimit) }
      },
      alert: async (state) => {
        if (!process.env.STORAGE_ALERT_WEBHOOK_URL) return
        await fetch(process.env.STORAGE_ALERT_WEBHOOK_URL, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event: 'storage_quota_warning', ...state }),
        })
      },
    })
    return NextResponse.json(snapshot)
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 502 })
  }
}

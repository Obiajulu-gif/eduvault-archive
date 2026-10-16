import { NextResponse } from 'next/server'
import { getDb } from '@/lib/mongodb'
import { getActorQuotaUsage, resetActorQuota, setActorQuotaOverride } from '@/lib/quotaManager'

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const actorId = searchParams.get('actorId')
  const resource = searchParams.get('resource') || 'storage'

  if (!actorId) {
    return NextResponse.json({ error: 'actorId is required' }, { status: 400 })
  }

  const db = await getDb()
  const usage = await getActorQuotaUsage(db, actorId, resource)
  return NextResponse.json(usage)
}

export async function POST(request) {
  const body = await request.json()
  const { actorId, resource, action, limit } = body

  if (!actorId || !resource || !action) {
    return NextResponse.json({ error: 'actorId, resource, and action are required' }, { status: 400 })
  }

  const db = await getDb()

  if (action === 'reset') {
    await resetActorQuota(db, actorId, resource)
    return NextResponse.json({ success: true, message: 'Quota reset successfully' })
  }

  if (action === 'override') {
    if (limit === undefined) {
      return NextResponse.json({ error: 'limit is required for override action' }, { status: 400 })
    }
    await setActorQuotaOverride(db, actorId, resource, limit)
    return NextResponse.json({ success: true, message: 'Quota override set successfully' })
  }

  return NextResponse.json({ error: 'invalid action' }, { status: 400 })
}

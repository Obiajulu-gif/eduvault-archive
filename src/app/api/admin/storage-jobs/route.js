// Admin API for storage health and maintenance jobs (#738, #739, #741)
import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/api/audit'
import { withApiHardening } from '@/lib/api/hardening'
import { getDb } from '@/lib/mongodb'
import { runPinVerificationWorker, runRepairActions } from '@/lib/workers/pinVerificationWorker'
import { runGarbageCollectionWorker, getGarbageCollectionStatus, estimateStorageRecovery } from '@/lib/workers/garbageCollectionWorker'
import { runIntegrityVerificationWorker, getIntegrityHealthReport } from '@/lib/workers/integrityVerificationWorker'

export const dynamic = 'force-dynamic'

// Middleware to verify admin access
async function requireAdmin(request) {
  // In production, verify JWT or admin token
  const adminToken = request.headers.get('x-admin-token')
  if (!adminToken || adminToken !== process.env.ADMIN_API_TOKEN) {
    return {
      authorized: false,
      response: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      ),
    }
  }
  return { authorized: true }
}

export async function POST(request) {
  return withApiHardening(
    request,
    { route: 'admin/storage-jobs', rateLimit: { limit: 10, windowMs: 60_000 } },
    async () => {
      const { authorized, response: authResponse } = await requireAdmin(request)
      if (!authorized) return authResponse

      try {
        const body = await request.json()
        const { action, options = {} } = body

        if (action === 'verify-pins') {
          auditLog({
            event: 'storage_job_started',
            route: 'admin/storage-jobs',
            method: 'POST',
            job: 'verify_pins',
          })

          const result = await runPinVerificationWorker({
            batchSize: options.batchSize || 100,
            samplingRate: options.samplingRate || 0.1,
            notifyOnFailure: options.notifyOnFailure || false,
            maxConcurrent: options.maxConcurrent || 5,
          })

          auditLog({
            event: 'storage_job_completed',
            route: 'admin/storage-jobs',
            method: 'POST',
            job: 'verify_pins',
            result: result.success,
          })

          return NextResponse.json({ success: true, job: 'verify_pins', ...result })
        }

        if (action === 'repair-pins') {
          auditLog({
            event: 'storage_job_started',
            route: 'admin/storage-jobs',
            method: 'POST',
            job: 'repair_pins',
          })

          const db = await getDb()
          const result = await runRepairActions(db, options.maxRepairs || 10)

          auditLog({
            event: 'storage_job_completed',
            route: 'admin/storage-jobs',
            method: 'POST',
            job: 'repair_pins',
            result: result.success,
          })

          return NextResponse.json({ success: true, job: 'repair_pins', ...result })
        }

        if (action === 'garbage-collection') {
          auditLog({
            event: 'storage_job_started',
            route: 'admin/storage-jobs',
            method: 'POST',
            job: 'garbage_collection',
          })

          const result = await runGarbageCollectionWorker({
            dryRun: options.dryRun !== false, // Default to true for safety
            limit: options.limit || 50,
            notifyOnError: options.notifyOnError || false,
            performCleanup: options.performCleanup || false,
          })

          auditLog({
            event: 'storage_job_completed',
            route: 'admin/storage-jobs',
            method: 'POST',
            job: 'garbage_collection',
            result: result.success,
          })

          return NextResponse.json({ success: true, job: 'garbage_collection', ...result })
        }

        if (action === 'verify-integrity') {
          auditLog({
            event: 'storage_job_started',
            route: 'admin/storage-jobs',
            method: 'POST',
            job: 'verify_integrity',
          })

          const result = await runIntegrityVerificationWorker({
            batchSize: options.batchSize || 50,
            samplingRate: options.samplingRate || 0.05,
            dryRun: options.dryRun !== false,
            notifyOnFailure: options.notifyOnFailure || false,
          })

          auditLog({
            event: 'storage_job_completed',
            route: 'admin/storage-jobs',
            method: 'POST',
            job: 'verify_integrity',
            result: result.success,
          })

          return NextResponse.json({ success: true, job: 'verify_integrity', ...result })
        }

        return NextResponse.json(
          { error: 'Unknown action' },
          { status: 400 }
        )
      } catch (error) {
        auditLog({
          event: 'storage_job_error',
          route: 'admin/storage-jobs',
          method: 'POST',
          status: 500,
          reason: error.message,
        })

        return NextResponse.json(
          { error: error.message },
          { status: 500 }
        )
      }
    }
  )
}

export async function GET(request) {
  return withApiHardening(
    request,
    { route: 'admin/storage-jobs', rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      const { authorized, response: authResponse } = await requireAdmin(request)
      if (!authorized) return authResponse

      try {
        const query = request.nextUrl.searchParams.get('status')

        if (query === 'pin-health') {
          // Pin verification status would be retrieved from health collection
          return NextResponse.json({
            success: true,
            status: 'pin-health',
            message: 'Use POST with action=verify-pins to run pin verification',
          })
        }

        if (query === 'gc-status') {
          const result = await getGarbageCollectionStatus()
          return NextResponse.json({ success: true, status: 'gc', ...result })
        }

        if (query === 'gc-estimate') {
          const result = await estimateStorageRecovery()
          return NextResponse.json({ success: true, status: 'gc_estimate', ...result })
        }

        if (query === 'integrity-health') {
          const result = await getIntegrityHealthReport()
          return NextResponse.json({ success: true, status: 'integrity', ...result })
        }

        return NextResponse.json({
          success: true,
          status: 'all',
          queries: [
            'pin-health',
            'gc-status',
            'gc-estimate',
            'integrity-health',
          ],
          message: 'Append ?status=<query> to get specific status',
        })
      } catch (error) {
        return NextResponse.json(
          { error: error.message },
          { status: 500 }
        )
      }
    }
  )
}

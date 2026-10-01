// Admin API for storage health and maintenance jobs (#738, #739, #741, #789)
// Migrated long-running operations to background worker framework with observability & retry capabilities
import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/api/audit'
import { withApiHardening } from '@/lib/api/hardening'
import { requirePermission } from '@/lib/api/auth'
import { getDb } from '@/lib/mongodb'
import {
  enqueueJob,
  inspectJob,
  listJobs,
  retryJob,
} from '@/lib/workers/backgroundWorker'
import { runPinVerificationWorker, runRepairActions } from '@/lib/workers/pinVerificationWorker'
import { runGarbageCollectionWorker, getGarbageCollectionStatus, estimateStorageRecovery } from '@/lib/workers/garbageCollectionWorker'
import { runIntegrityVerificationWorker, getIntegrityHealthReport } from '@/lib/workers/integrityVerificationWorker'
import { runStaleCacheRepairWorker, DERIVED_REGISTRY } from '@/lib/workers/staleCacheRepairWorker'

export const dynamic = 'force-dynamic'

export async function POST(request) {
  return withApiHardening(
    request,
    { route: 'admin/storage-jobs', rateLimit: { limit: 10, windowMs: 60_000 } },
    async () => {
      const authorization = await requirePermission(request, 'storage:maintain', { allowService: true })
      if (!authorization.ok) return NextResponse.json({ error: 'Forbidden' }, { status: authorization.status })

      try {
        const body = await request.json()
        const { action, options = {}, jobId } = body

        // 1. Retry a dead-lettered or failed job (#789)
        if (action === 'retry-job') {
          if (!jobId) {
            return NextResponse.json({ error: 'jobId is required to retry a job' }, { status: 400 })
          }

          const retried = await retryJob(jobId, {
            resetAttempts: options.resetAttempts !== false,
          })

          if (!retried) {
            return NextResponse.json(
              { error: 'Job not found or not in failed/dead_letter state' },
              { status: 404 }
            )
          }

          auditLog({
            event: 'storage_job_retried',
            route: 'admin/storage-jobs',
            method: 'POST',
            jobId,
          })

          return NextResponse.json({
            success: true,
            jobId,
            status: retried.status,
            message: 'Job re-queued for execution',
          })
        }

        // Standard maintenance action mapping to background worker types
        const actionToJobName = {
          'verify-pins': 'storage:verify-pins',
          'repair-pins': 'storage:repair-pins',
          'garbage-collection': 'storage:garbage-collection',
          'verify-integrity': 'storage:verify-integrity',
        }

        const jobName = actionToJobName[action]
        if (!jobName) {
          return NextResponse.json(
            { error: 'Unknown action' },
            { status: 400 }
          )
        }

        // Synchronous fallback if explicitly requested
        if (options.sync === true) {
          auditLog({
            event: 'storage_job_started_sync',
            route: 'admin/storage-jobs',
            method: 'POST',
            job: action,
          })

          let result
          if (action === 'verify-pins') {
            result = await runPinVerificationWorker(options)
          } else if (action === 'repair-pins') {
            const db = await getDb()
            result = await runRepairActions(db, options.maxRepairs || 10)
          } else if (action === 'garbage-collection') {
            result = await runGarbageCollectionWorker(options)
          } else if (action === 'verify-integrity') {
            result = await runIntegrityVerificationWorker(options)
          }

          auditLog({
            event: 'storage_job_completed_sync',
            route: 'admin/storage-jobs',
            method: 'POST',
            job: action,
            result: result?.success,
          })

          return NextResponse.json({ success: true, sync: true, job: action, ...result })
        }

        // Default: Enqueue into background worker queue (#789)
        const enqueued = await enqueueJob({
          name: jobName,
          payload: options,
          scheduledFor: options.scheduledFor || null,
          idempotencyKey: options.idempotencyKey || null,
          maxAttempts: options.maxAttempts || 3,
        })

        auditLog({
          event: 'storage_job_enqueued',
          route: 'admin/storage-jobs',
          method: 'POST',
          job: jobName,
          jobId: enqueued.jobId,
        })

        return NextResponse.json(
          {
            success: true,
            queued: true,
            jobId: enqueued.jobId,
            jobName: enqueued.name,
            status: enqueued.status,
            scheduledFor: enqueued.scheduledFor,
            message: `Job ${jobName} enqueued for background worker processing`,
          },
          { status: 202 }
        )
      } catch (error) {
        auditLog( {
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
      const authorization = await requirePermission(request, 'storage:maintain', { allowService: true })
      if (!authorization.ok) return NextResponse.json({ error: 'Forbidden' }, { status: authorization.status })

      try {
        const url = request.nextUrl
        const jobId = url.searchParams.get('jobId')

        // 1. Inspect a specific background job by ID (#789)
        if (jobId) {
          const job = await inspectJob(jobId)
          if (!job) {
            return NextResponse.json({ error: 'Job not found' }, { status: 404 })
          }
          return NextResponse.json({ success: true, job })
        }

        const query = url.searchParams.get('status')

        // 2. Query list of background jobs (#789)
        if (query === 'jobs') {
          const jobStatus = url.searchParams.get('jobStatus')
          const name = url.searchParams.get('name')
          const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100)
          const skip = Number(url.searchParams.get('skip')) || 0

          const { jobs, total } = await listJobs({
            status: jobStatus,
            name,
            limit,
            skip,
          })

          return NextResponse.json({ success: true, jobs, total, limit, skip })
        }

        if (query === 'pin-health') {
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

        if (query === 'stale-cache-configs') {
          return NextResponse.json({
            success: true,
            status: 'stale_cache_configs',
            configs: Object.keys(DERIVED_REGISTRY),
          })
        }

        return NextResponse.json({
          success: true,
          status: 'all',
          queries: [
            'jobs',
            'pin-health',
            'gc-status',
            'gc-estimate',
            'integrity-health',
            'stale-cache-configs',
          ],
          message: 'Append ?status=<query> to get specific status, or ?jobId=<id> to inspect a job',
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

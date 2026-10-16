// Background worker for garbage collection (#739)
// Identifies and unpins orphaned content

import { getDb } from '@/lib/mongodb'
import { getPinningProviders } from '@/lib/pinata'
import {
  performGarbageCollection,
  identifyOrphanedCids,
  getGCMetrics,
  GCPolicy,
} from '@/lib/storage/garbageCollection'

export async function runGarbageCollectionWorker(options = {}) {
  const {
    dryRun = true, // Start with dry-run to verify safety
    limit = 50,
    notifyOnError = false,
    performCleanup = false,
  } = options

  const db = await getDb()
  const providers = getPinningProviders()

  if (!providers || providers.length === 0) {
    console.error('[GarbageCollectionWorker] No pinning providers available')
    return {
      success: false,
      error: 'No pinning providers available',
    }
  }

  try {
    // First, identify orphaned CIDs in a dry-run
    const orphanReport = await identifyOrphanedCids(db, {
      dryRun: true,
      graceHours: GCPolicy.DELETED_GRACE_PERIOD_HOURS,
    })

    console.log(
      `[GarbageCollectionWorker] Found ${orphanReport.orphaned.length} orphaned CIDs`
    )

    // If dryRun is false and we have orphaned CIDs, proceed with deletion
    if (!dryRun && orphanReport.orphaned.length > 0 && performCleanup) {
      const gcResult = await performGarbageCollection(db, providers, {
        dryRun: false,
        limit,
        notifyOnError,
      })

      const metrics = await getGCMetrics(db)

      return {
        success: true,
        dryRun: false,
        ...gcResult,
        metrics,
      }
    }

    // Otherwise, return dry-run report
    return {
      success: true,
      dryRun: true,
      report: orphanReport,
      message: 'Dry-run report generated. Set dryRun=false and performCleanup=true to execute.',
    }
  } catch (error) {
    console.error('[GarbageCollectionWorker] Fatal error:', error)
    return {
      success: false,
      error: error.message,
    }
  }
}

export async function cleanupExpiredUploadSessions() {
  const db = await getDb()
  const uploadSessions = db.collection('upload_sessions')

  try {
    const now = new Date()
    const result = await uploadSessions.deleteMany({
      expiresAt: { $lt: now },
      state: { $in: ['failed', 'paused'] },
    })

    return {
      success: true,
      deletedSessions: result.deletedCount,
      timestamp: now,
    }
  } catch (error) {
    console.error('[CleanupExpiredSessions] Error:', error)
    return {
      success: false,
      error: error.message,
    }
  }
}

export async function getGarbageCollectionStatus() {
  const db = await getDb()

  try {
    const metrics = await getGCMetrics(db)

    // Get counts from audit log
    const gcAudit = db.collection('gc_audit_log')
    const last30d = new Date(Date.now() - 30 * 24 * 3600000)

    const monthlyStats = {
      total: await gcAudit.countDocuments({
        timestamp: { $gte: last30d },
      }),
      unpinned: await gcAudit.countDocuments({
        timestamp: { $gte: last30d },
        result: 'unpinned',
      }),
      failed: await gcAudit.countDocuments({
        timestamp: { $gte: last30d },
        result: 'error',
      }),
    }

    return {
      success: true,
      metrics,
      monthlyStats,
      status: 'GC system operational',
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
    }
  }
}

export async function estimateStorageRecovery() {
  const db = await getDb()

  try {
    const orphanReport = await identifyOrphanedCids(db, { dryRun: true })

    // Rough estimate: count materials marked for GC and sum their size
    const materials = db.collection('materials')
    const gcMaterials = await materials
      .aggregate([
        {
          $match: {
            'storage.markedForGC': true,
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            totalBytes: { $sum: { $toInt: '$storage.fileSizeBytes' } },
          },
        },
      ])
      .toArray()

    const stats = gcMaterials[0] || { count: 0, totalBytes: 0 }

    return {
      success: true,
      orphanedCids: orphanReport.orphaned.length,
      markedMaterials: stats.count,
      estimatedBytesRecoverable: stats.totalBytes,
      estimatedMBRecoverable: Math.round(stats.totalBytes / (1024 * 1024)),
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
    }
  }
}

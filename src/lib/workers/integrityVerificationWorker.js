// Background worker for content integrity verification (#741)
// Detects hash/CID mismatches and triggers remediation

import { getDb } from '@/lib/mongodb'
import { getPinningProviders } from '@/lib/pinata'
import {
  performBatchIntegrityCheck,
  getIntegrityMetrics,
  recordIntegrityFailure,
  suggestRemediationPath,
} from '@/lib/storage/integrityVerification'

export async function runIntegrityVerificationWorker(options = {}) {
  const {
    batchSize = 50,
    samplingRate = 0.05,
    dryRun = true,
    notifyOnFailure = false,
  } = options

  const db = await getDb()
  const providers = getPinningProviders()

  if (!providers || providers.length === 0) {
    console.error('[IntegrityVerificationWorker] No pinning providers available')
    return {
      success: false,
      error: 'No pinning providers available',
    }
  }

  try {
    const checkResult = await performBatchIntegrityCheck(db, providers, {
      batchSize,
      samplingRate,
      dryRun,
    })

    if (checkResult.failed > 0) {
      // Process failures and suggest remediation
      for (const failure of checkResult.failures) {
        try {
          const remediation = await suggestRemediationPath(
            db,
            failure.material,
            failure
          )

          if (notifyOnFailure) {
            console.warn(
              `[IntegrityVerificationWorker] Material ${failure.material} failed integrity check: ${failure.details}`
            )
            console.warn(`[IntegrityVerificationWorker] Suggested action: ${remediation.action}`)
          }

          // Queue notification/remediation as side effect
          await queueRemediationAction(db, failure.material, remediation)
        } catch (error) {
          console.error(
            `[IntegrityVerificationWorker] Failed to process remediation for ${failure.material}: ${error.message}`
          )
        }
      }
    }

    const metrics = await getIntegrityMetrics(db)

    return {
      success: true,
      ...checkResult,
      metrics,
      summary: `Checked ${checkResult.checked} materials: ${checkResult.passed} passed, ${checkResult.failed} failed`,
    }
  } catch (error) {
    console.error('[IntegrityVerificationWorker] Fatal error:', error)
    return {
      success: false,
      error: error.message,
    }
  }
}

export async function queueRemediationAction(db, materialId, remediation) {
  if (!db) throw new Error('Database required')

  const outbox = db.collection('side_effect_outbox')

  return outbox.insertOne({
    sourceAggregate: 'material',
    sourceId: materialId,
    intent: {
      type: 'notification',
      channel: 'integrity_remediation',
      payload: {
        action: remediation.action,
        reason: remediation.reason,
        ...remediation,
      },
    },
    status: 'pending',
    createdAt: new Date(),
    nextAttemptAt: new Date(),
    attempts: 0,
  })
}

export async function processIntegrityFailures(options = {}) {
  const {
    limit = 20,
    autoResolve = false,
  } = options

  const db = await getDb()
  const integrityLog = db.collection('integrity_failures')
  const materials = db.collection('materials')

  try {
    // Find unresolved failures
    const failures = await integrityLog
      .find({ resolved: false })
      .limit(limit)
      .toArray()

    const results = {
      processed: 0,
      resolved: 0,
      escalated: 0,
      actions: [],
    }

    for (const failure of failures) {
      try {
        const material = await materials.findOne({ _id: failure.materialId })

        if (!material) {
          // Material deleted, can mark failure as resolved
          await integrityLog.updateOne(
            { _id: failure._id },
            { $set: { resolved: true, resolvedAt: new Date(), resolvedReason: 'Material deleted' } }
          )
          results.resolved++
          continue
        }

        // Check if issue still exists
        const latestCheck = await integrityLog
          .findOne(
            { materialId: material._id },
            { sort: { timestamp: -1 } }
          )

        if (latestCheck?.timestamp > failure.timestamp && latestCheck?.status !== 'mismatch') {
          // Issue resolved itself
          await integrityLog.updateOne(
            { _id: failure._id },
            { $set: { resolved: true, resolvedAt: new Date(), resolvedReason: 'Issue resolved' } }
          )
          results.resolved++
          continue
        }

        // Escalate if still unresolved
        if (!autoResolve) {
          results.escalated++
          results.actions.push({
            materialId: material._id,
            action: 'escalate_to_review',
            failureId: failure._id,
          })
        }

        results.processed++
      } catch (error) {
        console.error(
          `[ProcessIntegrityFailures] Error processing failure ${failure._id}: ${error.message}`
        )
      }
    }

    return {
      success: true,
      ...results,
      summary: `Processed ${results.processed} failures: ${results.resolved} resolved, ${results.escalated} escalated`,
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
    }
  }
}

export async function getIntegrityHealthReport() {
  const db = await getDb()

  try {
    const metrics = await getIntegrityMetrics(db)
    const materials = db.collection('materials')
    const integrityLog = db.collection('integrity_failures')

    // Get some statistics
    const stats = {
      materialsWithStoredHash: await materials.countDocuments({
        'storage.contentHash': { $exists: true },
      }),
      materialsWithoutHash: await materials.countDocuments({
        'storage.contentHash': { $exists: false },
        state: 'published',
      }),
      unresolvedFailures: await integrityLog.countDocuments({
        resolved: false,
      }),
    }

    const healthPercentage = stats.materialsWithStoredHash > 0
      ? Math.round((stats.materialsWithStoredHash / (stats.materialsWithStoredHash + stats.materialsWithoutHash || 1)) * 100)
      : 0

    return {
      success: true,
      health: {
        status: healthPercentage > 90 ? 'healthy' : healthPercentage > 70 ? 'warning' : 'critical',
        percentage: healthPercentage,
      },
      metrics,
      stats,
      recommendations: healthPercentage < 90 ? ['Increase hash computation coverage', 'Review sampling rate'] : [],
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
    }
  }
}

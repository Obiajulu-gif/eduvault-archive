// Background worker for pin verification (#738)
// Monitors IPFS pin health and triggers repairs

import { getDb } from '@/lib/mongodb'
import { getPinningProviders } from '@/lib/pinata'
import {
  verifyPinRetrievability,
  updateMaterialPinHealth,
  suggestRepairAction,
  PinHealthStatus,
  PinRepairAction,
  scheduleHealthCheckBatch,
} from '@/lib/storage/pinVerification'

export async function runPinVerificationWorker(options = {}) {
  const {
    batchSize = 100,
    samplingRate = 0.1,
    notifyOnFailure = false,
    maxConcurrent = 5,
  } = options

  const db = await getDb()
  const providers = getPinningProviders()

  if (!providers || providers.length === 0) {
    console.error('[PinVerificationWorker] No pinning providers available')
    return {
      success: false,
      error: 'No pinning providers available',
    }
  }

  try {
    // Schedule a batch of materials for verification
    const batch = await scheduleHealthCheckBatch(db, batchSize, samplingRate)

    if (batch.scheduledCount === 0) {
      return {
        success: true,
        checked: 0,
        message: 'No materials scheduled for verification',
      }
    }

    const results = {
      checked: 0,
      healthy: 0,
      degraded: 0,
      unreachable: 0,
      actions: [],
      errors: [],
    }

    // Process materials with concurrency control
    const queue = [...batch.materials]
    const activePromises = new Set()

    while (queue.length > 0 || activePromises.size > 0) {
      // Fill up to maxConcurrent
      while (queue.length > 0 && activePromises.size < maxConcurrent) {
        const material = queue.shift()
        const promise = (async () => {
          try {
            const verificationResult = await verifyPinRetrievability(
              material.cid,
              providers
            )

            await updateMaterialPinHealth(
              db,
              material._id,
              verificationResult.status,
              verificationResult
            )

            // Determine if repair is needed
            const material_full = await db.collection('materials').findOne({ _id: material._id })
            const repairAction = await suggestRepairAction(db, material_full)

            results.checked++

            if (verificationResult.status === PinHealthStatus.HEALTHY) {
              results.healthy++
            } else if (verificationResult.status === PinHealthStatus.DEGRADED) {
              results.degraded++
              results.actions.push({
                materialId: material._id,
                action: repairAction,
                reason: verificationResult.details,
              })
            } else if (verificationResult.status === PinHealthStatus.UNREACHABLE) {
              results.unreachable++
              results.actions.push({
                materialId: material._id,
                action: repairAction,
                reason: verificationResult.details,
              })

              if (notifyOnFailure) {
                console.warn(
                  `[PinVerificationWorker] Material ${material._id} (${material.title}) is unreachable`
                )
              }
            }
          } catch (error) {
            results.errors.push({
              materialId: material._id,
              error: error.message,
            })
          }
        })()

        activePromises.add(promise)
        promise.finally(() => activePromises.delete(promise))
      }

      // Wait for at least one to finish
      if (activePromises.size > 0) {
        await Promise.race(activePromises)
      }
    }

    return {
      success: true,
      ...results,
      summary: `Checked ${results.checked} materials: ${results.healthy} healthy, ${results.degraded} degraded, ${results.unreachable} unreachable`,
    }
  } catch (error) {
    console.error('[PinVerificationWorker] Fatal error:', error)
    return {
      success: false,
      error: error.message,
    }
  }
}

export async function runRepairActions(db, maxRepairs = 10) {
  if (!db) throw new Error('Database required')

  const materials = db.collection('materials')
  const providers = getPinningProviders()

  // Find materials that need repair
  const needsRepair = await materials
    .find({
      'storage.requiresRepair': true,
      'storage.repairAttempts.nextRetry': { $lte: new Date() },
    })
    .limit(maxRepairs)
    .toArray()

  const results = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    actions: [],
  }

  for (const material of needsRepair) {
    try {
      // Suggest and attempt repair
      const repairAction = await suggestRepairAction(db, material)

      if (repairAction === PinRepairAction.RE_PIN) {
        // Would re-pin from secondary or request from creator
        results.actions.push({
          materialId: material._id,
          action: 're_pin',
          status: 'queued',
        })
        results.succeeded++
      } else if (repairAction === PinRepairAction.NOTIFY_CREATOR) {
        // Would send notification
        results.actions.push({
          materialId: material._id,
          action: 'notify_creator',
          status: 'notification_queued',
        })
        results.succeeded++
      } else if (repairAction === PinRepairAction.FLAG_LISTING) {
        // Mark as degraded but still accessible
        await materials.updateOne(
          { _id: material._id },
          {
            $set: {
              'storage.pinHealth.status': 'degraded',
              'storage.requiresRepair': false,
            },
          }
        )
        results.succeeded++
      }

      // Update repair attempt count
      await materials.updateOne(
        { _id: material._id },
        {
          $inc: { 'storage.repairAttempts.count': 1 },
          $set: {
            'storage.repairAttempts.lastAttempt': new Date(),
            'storage.repairAttempts.nextRetry': new Date(
              Date.now() + 3600000 * Math.pow(2, material.storage?.repairAttempts?.count || 0)
            ), // Exponential backoff
          },
        }
      )

      results.attempted++
    } catch (error) {
      results.failed++
      results.actions.push({
        materialId: material._id,
        error: error.message,
        status: 'failed',
      })
    }
  }

  return {
    ...results,
    summary: `Repair: attempted ${results.attempted}, succeeded ${results.succeeded}, failed ${results.failed}`,
  }
}

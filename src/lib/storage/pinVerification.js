// Pin verification and repair job for Pinata-pinned content (#738)
// Monitors the health and retrievability of pinned CIDs

import { getPinningProviders, resolveFromGateways } from './pinningService.js'

export class PinHealthStatus {
  static HEALTHY = 'healthy'
  static DEGRADED = 'degraded'
  static UNREACHABLE = 'unreachable'
  static UNKNOWN = 'unknown'
}

export class PinRepairAction {
  static NONE = 'none'
  static RE_PIN = 're_pin'
  static NOTIFY_CREATOR = 'notify_creator'
  static FLAG_LISTING = 'flag_listing'
}

export async function verifyPinRetrievability(cid, providers, options = {}) {
  const {
    fetchImpl = fetch,
    maxRetries = 3,
    multiGatewayRequired = true,
    timeoutMs = 30000,
  } = options

  if (!cid) throw new Error('CID is required for verification')

  const results = {
    cid,
    timestamp: new Date(),
    gateways: [],
    status: PinHealthStatus.UNKNOWN,
    retrievable: false,
    details: '',
  }

  if (!providers || providers.length === 0) {
    results.status = PinHealthStatus.UNKNOWN
    results.details = 'No providers available for verification'
    return results
  }

  let successCount = 0
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

  try {
    for (const provider of providers) {
      try {
        const url = await provider.gatewayUrl(cid)
        const response = await fetchImpl(url, {
          method: 'HEAD',
          signal: controller.signal,
        })

        const gatewayResult = {
          provider: provider.name,
          status: response.status,
          ok: response.ok,
          timestamp: new Date(),
        }

        if (response.ok) {
          successCount++
        }

        results.gateways.push(gatewayResult)
      } catch (error) {
        results.gateways.push({
          provider: provider.name,
          status: null,
          ok: false,
          error: error.message,
          timestamp: new Date(),
        })
      }
    }

    clearTimeout(timeoutHandle)

    // Determine overall health status
    if (successCount === 0) {
      results.status = PinHealthStatus.UNREACHABLE
      results.details = `All gateways failed: ${results.gateways.map((g) => `${g.provider}:${g.status || g.error}`).join(', ')}`
    } else if (multiGatewayRequired && successCount < Math.ceil(providers.length / 2)) {
      results.status = PinHealthStatus.DEGRADED
      results.details = `Only ${successCount}/${providers.length} gateways healthy`
    } else {
      results.status = PinHealthStatus.HEALTHY
      results.details = `Verified across ${successCount} gateway(s)`
    }

    results.retrievable = results.status !== PinHealthStatus.UNREACHABLE
  } catch (error) {
    results.status = PinHealthStatus.UNKNOWN
    results.details = `Verification error: ${error.message}`
  }

  return results
}

export async function updateMaterialPinHealth(db, materialId, healthStatus, verificationResult) {
  if (!db) throw new Error('Database connection required')
  if (!materialId) throw new Error('Material ID required')

  const materials = db.collection('materials')

  const updateDoc = {
    'storage.pinHealth': {
      status: healthStatus,
      lastVerified: new Date(),
      verificationDetails: verificationResult.details,
      gatewayResults: verificationResult.gateways.slice(0, 5), // Limit history
    },
    'storage.lastHealthCheck': new Date(),
  }

  if (healthStatus === PinHealthStatus.UNREACHABLE) {
    updateDoc['storage.requiresRepair'] = true
    updateDoc['storage.repairAttempts'] = {
      count: 0,
      lastAttempt: null,
      nextRetry: new Date(Date.now() + 3600000), // 1 hour backoff
    }
  }

  return materials.updateOne(
    { _id: materialId },
    { $set: updateDoc },
    { upsert: false }
  )
}

export async function suggestRepairAction(db, material) {
  if (!material.storage?.pinHealth?.status) {
    return PinRepairAction.NONE
  }

  const status = material.storage.pinHealth.status

  // If unhealthy, escalate to notification/repair
  if (status === PinHealthStatus.UNREACHABLE) {
    const hasBackupPin = material.storage?.secondaryPin
    return hasBackupPin ? PinRepairAction.RE_PIN : PinRepairAction.NOTIFY_CREATOR
  }

  if (status === PinHealthStatus.DEGRADED) {
    return PinRepairAction.FLAG_LISTING
  }

  return PinRepairAction.NONE
}

export async function scheduleHealthCheckBatch(db, batchSize = 100, samplingRate = 0.1) {
  if (!db) throw new Error('Database connection required')

  const materials = db.collection('materials')

  // Random sampling: check ~10% of listings to avoid overwhelming gateways
  const materialCount = await materials.countDocuments()
  const skip = Math.floor(Math.random() * Math.max(1, materialCount - batchSize))

  const materialsToCheck = await materials
    .find({
      'storage.cid': { $exists: true },
      'state': 'published',
    })
    .skip(skip)
    .limit(batchSize)
    .toArray()

  return {
    scheduledCount: materialsToCheck.length,
    totalCount: materialCount,
    samplingRate: Math.min(1, batchSize / materialCount),
    materials: materialsToCheck.map((m) => ({
      _id: m._id,
      cid: m.storage?.cid,
      title: m.title,
    })),
  }
}

// Garbage collection for unpurchased and orphaned Pinata uploads (#739)
// Safely identifies and unpins content that is no longer referenced

export const UploadState = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  DELETED: 'deleted',
  FAILED: 'failed',
}

export const GCPolicy = {
  DRAFT_TTL_HOURS: 24, // Drafts expire after 24 hours
  FAILED_TTL_HOURS: 6, // Failed uploads cleaned up after 6 hours
  DELETED_GRACE_PERIOD_HOURS: 72, // 3-day grace period after deletion
  MIN_AGE_HOURS: 1, // Minimum age before GC considers a pin
}

export async function identifyOrphanedCids(db, options = {}) {
  const {
    dryRun = true,
    graceHours = GCPolicy.DELETED_GRACE_PERIOD_HOURS,
  } = options

  if (!db) throw new Error('Database connection required')

  const materials = db.collection('materials')
  const now = new Date()
  const graceWindow = new Date(now - graceHours * 3600000)

  // Find all CIDs in materials collection
  const publishedCids = new Set()
  const draftCids = new Map() // Map of CID -> material with grace period
  const orphanedCids = []

  const allMaterials = await materials
    .find({
      'storage.cid': { $exists: true },
    })
    .toArray()

  for (const material of allMaterials) {
    const cid = material.storage?.cid
    const thumbnailCid = material.storage?.thumbnailCid
    const state = material.state || 'unknown'

    if (cid) {
      if (state === UploadState.PUBLISHED) {
        publishedCids.add(cid)
      } else if (state === UploadState.DRAFT) {
        const createdAt = material.createdAt || new Date()
        draftCids.set(cid, {
          materialId: material._id,
          createdAt,
          age: now - createdAt,
        })
      } else if (state === UploadState.DELETED) {
        const deletedAt = material.deletedAt || material.updatedAt || new Date()
        if (deletedAt < graceWindow) {
          orphanedCids.push({
            cid,
            materialId: material._id,
            type: 'deleted_expired',
            reason: `Material deleted ${Math.round((now - deletedAt) / 3600000)}h ago`,
          })
        }
      }
    }

    if (thumbnailCid && state === UploadState.PUBLISHED) {
      publishedCids.add(thumbnailCid)
    }
  }

  // Find drafts older than TTL
  const draftTtlMs = GCPolicy.DRAFT_TTL_HOURS * 3600000
  for (const [cid, metadata] of draftCids.entries()) {
    if (metadata.age > draftTtlMs) {
      orphanedCids.push({
        cid,
        materialId: metadata.materialId,
        type: 'draft_expired',
        reason: `Draft not published for ${Math.round(metadata.age / 3600000)}h`,
      })
    }
  }

  return {
    timestamp: now,
    dryRun,
    statistics: {
      publishedCids: publishedCids.size,
      draftCids: draftCids.size,
      orphanedCids: orphanedCids.length,
    },
    orphaned: orphanedCids,
  }
}

export async function unpinCid(provider, cid, dryRun = true) {
  if (!provider) throw new Error('Pinning provider required')
  if (!cid) throw new Error('CID required')

  if (dryRun) {
    return {
      cid,
      dryRun: true,
      status: 'would_unpin',
      message: `Would unpin ${cid} via ${provider.name || 'unknown'}`,
    }
  }

  // Check if provider supports unpin
  if (!provider.unpin) {
    return {
      cid,
      status: 'error',
      message: `Provider ${provider.name || 'unknown'} does not support unpin`,
    }
  }

  try {
    await provider.unpin(cid)
    return {
      cid,
      status: 'unpinned',
      timestamp: new Date(),
    }
  } catch (error) {
    return {
      cid,
      status: 'error',
      message: error.message,
    }
  }
}

export async function recordGCAction(db, cid, action, result) {
  if (!db) throw new Error('Database connection required')

  const gcAuditLog = db.collection('gc_audit_log')

  return gcAuditLog.insertOne({
    cid,
    action,
    result: result.status,
    details: result.message || result.reason,
    timestamp: new Date(),
    dryRun: result.dryRun || false,
  })
}

export async function markMaterialForGC(db, materialId, reason) {
  if (!db) throw new Error('Database connection required')
  if (!materialId) throw new Error('Material ID required')

  const materials = db.collection('materials')

  return materials.updateOne(
    { _id: materialId },
    {
      $set: {
        'storage.markedForGC': true,
        'storage.gcReason': reason,
        'storage.gcMarkedAt': new Date(),
      },
    },
    { upsert: false }
  )
}

export async function performGarbageCollection(db, providers, options = {}) {
  const {
    dryRun = true,
    limit = 50,
    notifyOnError = false,
  } = options

  if (!db) throw new Error('Database connection required')
  if (!providers || providers.length === 0) {
    throw new Error('At least one pinning provider required')
  }

  const gcReport = await identifyOrphanedCids(db, { dryRun })
  const primaryProvider = providers[0]

  const results = {
    dryRun,
    startTime: new Date(),
    totalOrphaned: gcReport.orphaned.length,
    processed: 0,
    unpinned: 0,
    errors: [],
    actions: [],
  }

  // Process up to limit
  for (let i = 0; i < Math.min(limit, gcReport.orphaned.length); i++) {
    const orphan = gcReport.orphaned[i]

    try {
      const unpinResult = await unpinCid(primaryProvider, orphan.cid, dryRun)
      results.actions.push({
        cid: orphan.cid,
        result: unpinResult,
      })

      if (unpinResult.status === 'unpinned' || unpinResult.status === 'would_unpin') {
        results.unpinned++
      }

      await recordGCAction(db, orphan.cid, 'gc_attempt', {
        status: unpinResult.status,
        message: unpinResult.message,
        reason: orphan.reason,
        dryRun,
      })

      if (unpinResult.status === 'unpinned') {
        await markMaterialForGC(db, orphan.materialId, orphan.reason)
      }
    } catch (error) {
      results.errors.push({
        cid: orphan.cid,
        error: error.message,
      })

      if (notifyOnError) {
        console.error(`[GC] Failed to unpin ${orphan.cid}: ${error.message}`)
      }
    }

    results.processed++
  }

  results.endTime = new Date()
  results.duration = results.endTime - results.startTime

  return results
}

export async function getGCMetrics(db) {
  if (!db) throw new Error('Database connection required')

  const gcAudit = db.collection('gc_audit_log')

  const last24h = new Date(Date.now() - 24 * 3600000)

  const metrics = {
    last24h: await gcAudit
      .countDocuments({
        timestamp: { $gte: last24h },
      }),
    totalUnpinned: await gcAudit.countDocuments({
      result: 'unpinned',
    }),
    totalErrors: await gcAudit.countDocuments({
      result: 'error',
    }),
  }

  return metrics
}

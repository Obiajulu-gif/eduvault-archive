// Content integrity verification between MongoDB metadata and IPFS CIDs (#741)
// Detects and handles hash/CID mismatches

import { createHash } from 'node:crypto'
import { resolveFromGateways } from './pinningService.js'

export const IntegrityStatus = {
  VERIFIED = 'verified',
  MISMATCH = 'mismatch',
  UNREACHABLE = 'unreachable',
  UNKNOWN = 'unknown',
}

export const HashAlgorithm = {
  SHA256: 'sha256',
  SHA512: 'sha512',
}

export async function computeContentHash(content, algorithm = HashAlgorithm.SHA256) {
  if (!content) throw new Error('Content required for hash computation')

  const buffer = content instanceof Buffer ? content : Buffer.from(content)
  return createHash(algorithm).update(buffer).digest('hex')
}

export async function verifyContentIntegrity(retrievedContent, storedHash, algorithm = HashAlgorithm.SHA256) {
  if (!retrievedContent) {
    return {
      status: IntegrityStatus.UNREACHABLE,
      details: 'Content could not be retrieved',
      match: false,
    }
  }

  if (!storedHash) {
    return {
      status: IntegrityStatus.UNKNOWN,
      details: 'No stored hash available for comparison',
      match: false,
    }
  }

  try {
    const computedHash = await computeContentHash(retrievedContent, algorithm)

    return {
      status: computedHash === storedHash ? IntegrityStatus.VERIFIED : IntegrityStatus.MISMATCH,
      details: computedHash === storedHash
        ? 'Content matches stored hash'
        : `Hash mismatch: computed ${computedHash.slice(0, 16)}... but expected ${storedHash.slice(0, 16)}...`,
      match: computedHash === storedHash,
      computedHash,
      storedHash,
    }
  } catch (error) {
    return {
      status: IntegrityStatus.UNKNOWN,
      details: `Hash computation failed: ${error.message}`,
      match: false,
      error: error.message,
    }
  }
}

export async function sampledVerifyMaterial(providers, material, options = {}) {
  const {
    samplingRate = 0.05, // 5% sampling by default
    fetchImpl = fetch,
    timeoutMs = 30000,
  } = options

  if (!material?.storage?.cid) {
    return {
      material: material?._id,
      status: IntegrityStatus.UNKNOWN,
      details: 'Material missing CID',
      verified: false,
    }
  }

  // Sampling: randomly skip some verifications to reduce load
  if (Math.random() > samplingRate) {
    return {
      material: material._id,
      status: 'skipped_sampling',
      details: `Skipped due to ${(samplingRate * 100).toFixed(1)}% sampling rate`,
      verified: null, // Unknown, not verified
    }
  }

  const cid = material.storage.cid
  const storedHash = material.storage.contentHash
  const hashAlgorithm = material.storage.hashAlgorithm || HashAlgorithm.SHA256

  if (!storedHash) {
    return {
      material: material._id,
      cid,
      status: IntegrityStatus.UNKNOWN,
      details: 'No content hash stored for material',
      verified: false,
    }
  }

  try {
    // Fetch content from gateway
    const retrievedResult = await resolveFromGateways(cid, providers, fetchImpl)
    const response = await fetchImpl(retrievedResult.url, {
      timeout: timeoutMs,
    })

    if (!response.ok) {
      return {
        material: material._id,
        cid,
        status: IntegrityStatus.UNREACHABLE,
        details: `Gateway returned ${response.status}`,
        verified: false,
      }
    }

    const contentBuffer = await response.arrayBuffer()
    const verificationResult = await verifyContentIntegrity(
      contentBuffer,
      storedHash,
      hashAlgorithm
    )

    return {
      material: material._id,
      cid,
      title: material.title,
      ...verificationResult,
      verified: verificationResult.match,
    }
  } catch (error) {
    return {
      material: material._id,
      cid,
      status: IntegrityStatus.UNKNOWN,
      details: `Verification error: ${error.message}`,
      verified: false,
      error: error.message,
    }
  }
}

export async function storeContentHash(db, materialId, contentHash, algorithm = HashAlgorithm.SHA256) {
  if (!db) throw new Error('Database connection required')
  if (!materialId) throw new Error('Material ID required')
  if (!contentHash) throw new Error('Content hash required')

  const materials = db.collection('materials')

  return materials.updateOne(
    { _id: materialId },
    {
      $set: {
        'storage.contentHash': contentHash,
        'storage.hashAlgorithm': algorithm,
        'storage.hashComputedAt': new Date(),
      },
    },
    { upsert: false }
  )
}

export async function recordIntegrityFailure(db, materialId, integrityResult) {
  if (!db) throw new Error('Database connection required')

  const integrityLog = db.collection('integrity_failures')

  const record = {
    materialId,
    cid: integrityResult.cid,
    computedHash: integrityResult.computedHash,
    storedHash: integrityResult.storedHash,
    status: integrityResult.status,
    details: integrityResult.details,
    timestamp: new Date(),
    resolved: false,
  }

  await integrityLog.insertOne(record)

  // Mark material as requiring attention
  const materials = db.collection('materials')
  await materials.updateOne(
    { _id: materialId },
    {
      $set: {
        'storage.integrityIssue': true,
        'storage.lastIntegrityFailure': new Date(),
      },
    },
    { upsert: false }
  )

  return record
}

export async function suggestRemediationPath(db, materialId, integrityFailure) {
  if (!db) throw new Error('Database connection required')

  const materials = db.collection('materials')
  const purchases = db.collection('purchases')
  const material = await materials.findOne({ _id: materialId })

  if (!material) {
    return {
      action: 'none',
      reason: 'Material not found',
    }
  }

  // Check if there are existing purchases
  const purchaseCount = await purchases.countDocuments({ materialId })

  if (purchaseCount > 0) {
    return {
      action: 'notify_and_review',
      reason: `Material has ${purchaseCount} purchases; integrity issue affects customers`,
      notification: {
        creatorEmail: material.creatorEmail,
        title: material.title,
        cid: integrityFailure.cid,
        message: 'Your uploaded material has failed integrity verification',
      },
    }
  }

  // No purchases yet - can safely re-upload
  return {
    action: 'request_creator_reupload',
    reason: 'No purchases yet; safe to request fresh upload',
    steps: [
      'Notify creator of integrity issue',
      'Provide option to re-upload material',
      'Remove current corrupted CID on confirmation',
    ],
  }
}

export async function performBatchIntegrityCheck(db, providers, options = {}) {
  const {
    batchSize = 50,
    samplingRate = 0.05,
    dryRun = false,
  } = options

  if (!db) throw new Error('Database connection required')
  if (!providers || providers.length === 0) {
    throw new Error('At least one provider required')
  }

  const materials = db.collection('materials')
  const checkResults = []
  const failures = []

  // Fetch materials to check (sampling across all materials)
  const totalCount = await materials.countDocuments({ 'storage.cid': { $exists: true } })
  const skip = Math.floor(Math.random() * Math.max(1, totalCount - batchSize))

  const materialsToCheck = await materials
    .find({ 'storage.cid': { $exists: true }, state: 'published' })
    .skip(skip)
    .limit(batchSize)
    .toArray()

  for (const material of materialsToCheck) {
    const result = await sampledVerifyMaterial(providers, material, { samplingRate })

    if (result.verified === false && result.status === IntegrityStatus.MISMATCH) {
      failures.push({
        materialId: material._id,
        ...result,
      })

      if (!dryRun) {
        await recordIntegrityFailure(db, material._id, result)
      }
    }

    checkResults.push(result)
  }

  return {
    timestamp: new Date(),
    dryRun,
    checked: checkResults.length,
    passed: checkResults.filter((r) => r.verified === true).length,
    failed: failures.length,
    skipped: checkResults.filter((r) => r.status === 'skipped_sampling').length,
    failures,
    summary: `Checked ${checkResults.length} materials: ${failures.length} integrity failures`,
  }
}

export async function getIntegrityMetrics(db) {
  if (!db) throw new Error('Database connection required')

  const integrityLog = db.collection('integrity_failures')
  const materials = db.collection('materials')

  const last7d = new Date(Date.now() - 7 * 24 * 3600000)

  return {
    totalFailures: await integrityLog.countDocuments(),
    failuresLast7d: await integrityLog.countDocuments({
      timestamp: { $gte: last7d },
    }),
    materialsWithIssues: await materials.countDocuments({
      'storage.integrityIssue': true,
    }),
    resolvedIssues: await integrityLog.countDocuments({
      resolved: true,
    }),
  }
}

// Chunked, resumable uploads for large course materials (#740)
// Supports multi-part uploads with progress tracking and integrity verification

import { createHash } from 'node:crypto'

export const ChunkState = {
  PENDING: 'pending',
  UPLOADED: 'uploaded',
  VERIFIED: 'verified',
  FAILED: 'failed',
}

export const UploadSessionState = {
  INITIALIZED: 'initialized',
  IN_PROGRESS: 'in_progress',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
}

export class UploadSessionManager {
  constructor(db) {
    if (!db) throw new Error('Database connection required')
    this.db = db
    this.uploadSessions = db.collection('upload_sessions')
    this.uploadChunks = db.collection('upload_chunks')
  }

  async createSession(fileMetadata, options = {}) {
    const {
      chunkSize = 5 * 1024 * 1024, // 5MB default
      totalChunks,
      creatorAddress,
      resumeToken,
    } = options

    if (!fileMetadata.fileName) throw new Error('File name required')
    if (!totalChunks) throw new Error('Total chunks count required')

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const uploadToken = resumeToken || this._generateToken()

    const session = {
      _id: sessionId,
      uploadToken,
      fileMetadata,
      chunkSize,
      totalChunks,
      completedChunks: 0,
      uploadedBytes: 0,
      totalBytes: fileMetadata.size,
      state: UploadSessionState.INITIALIZED,
      creatorAddress,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 3600000), // 7-day TTL
      chunks: {},
    }

    await this.uploadSessions.insertOne(session)
    return session
  }

  async getSession(sessionId, uploadToken) {
    if (!sessionId || !uploadToken) throw new Error('Session ID and upload token required')

    const session = await this.uploadSessions.findOne({ _id: sessionId })

    if (!session) {
      throw new Error('Session not found')
    }

    if (session.uploadToken !== uploadToken) {
      throw new Error('Invalid upload token')
    }

    if (new Date() > session.expiresAt) {
      await this.uploadSessions.updateOne(
        { _id: sessionId },
        { $set: { state: UploadSessionState.FAILED } }
      )
      throw new Error('Upload session expired')
    }

    return session
  }

  async recordChunkUpload(sessionId, chunkIndex, chunkHash, chunkSize) {
    if (!sessionId || chunkIndex === undefined || !chunkHash) {
      throw new Error('Session ID, chunk index, and hash required')
    }

    const chunk = {
      _id: `${sessionId}_chunk_${chunkIndex}`,
      sessionId,
      chunkIndex,
      chunkHash,
      chunkSize,
      state: ChunkState.UPLOADED,
      uploadedAt: new Date(),
    }

    await this.uploadChunks.updateOne(
      { _id: chunk._id },
      { $set: chunk },
      { upsert: true }
    )

    // Update session progress
    const session = await this.uploadSessions.findOne({ _id: sessionId })
    const completedChunks = await this.uploadChunks.countDocuments({
      sessionId,
      state: { $in: [ChunkState.UPLOADED, ChunkState.VERIFIED] },
    })

    const uploadedBytes = await this.uploadChunks
      .aggregate([
        { $match: { sessionId, state: { $in: [ChunkState.UPLOADED, ChunkState.VERIFIED] } } },
        { $group: { _id: null, total: { $sum: '$chunkSize' } } },
      ])
      .toArray()

    const totalUploadedBytes = uploadedBytes[0]?.total || 0

    const progress = {
      completedChunks,
      uploadedBytes: totalUploadedBytes,
      percentage: Math.round((totalUploadedBytes / session.totalBytes) * 100),
    }

    await this.uploadSessions.updateOne(
      { _id: sessionId },
      {
        $set: {
          completedChunks: progress.completedChunks,
          uploadedBytes: progress.uploadedBytes,
          lastActivityAt: new Date(),
          state: progress.percentage === 100 ? UploadSessionState.COMPLETED : UploadSessionState.IN_PROGRESS,
        },
      }
    )

    return progress
  }

  async getSessionProgress(sessionId) {
    if (!sessionId) throw new Error('Session ID required')

    const session = await this.uploadSessions.findOne({ _id: sessionId })
    if (!session) throw new Error('Session not found')

    const chunks = await this.uploadChunks
      .find({ sessionId })
      .toArray()

    return {
      sessionId,
      totalChunks: session.totalChunks,
      completedChunks: session.completedChunks,
      totalBytes: session.totalBytes,
      uploadedBytes: session.uploadedBytes,
      percentage: Math.round((session.uploadedBytes / session.totalBytes) * 100),
      state: session.state,
      chunks: chunks.map((c) => ({
        index: c.chunkIndex,
        state: c.state,
        hash: c.chunkHash.slice(0, 8) + '...', // Truncate for display
      })),
    }
  }

  async verifyAndFinalizeSession(sessionId, finalFileHash) {
    if (!sessionId || !finalFileHash) {
      throw new Error('Session ID and final file hash required')
    }

    const session = await this.uploadSessions.findOne({ _id: sessionId })
    if (!session) throw new Error('Session not found')

    if (session.state !== UploadSessionState.COMPLETED) {
      throw new Error(`Cannot finalize session in state: ${session.state}`)
    }

    // Verify all chunks are uploaded
    const uploadedChunks = await this.uploadChunks
      .countDocuments({
        sessionId,
        state: { $in: [ChunkState.UPLOADED, ChunkState.VERIFIED] },
      })

    if (uploadedChunks !== session.totalChunks) {
      throw new Error(
        `Expected ${session.totalChunks} chunks but only ${uploadedChunks} are uploaded`
      )
    }

    // Compute manifest hash from chunk hashes
    const chunks = await this.uploadChunks
      .find({ sessionId })
      .sort({ chunkIndex: 1 })
      .toArray()

    const chunkHashString = chunks.map((c) => c.chunkHash).join('')
    const manifestHash = createHash('sha256').update(chunkHashString).digest('hex')

    return {
      sessionId,
      finalFileHash,
      manifestHash,
      verified: true,
      totalChunks: session.totalChunks,
      totalBytes: session.uploadedBytes,
    }
  }

  async cleanupExpiredSessions() {
    const now = new Date()

    const result = await this.uploadSessions.deleteMany({
      expiresAt: { $lt: now },
      state: { $in: [UploadSessionState.FAILED, UploadSessionState.PAUSED] },
    })

    return {
      deletedSessions: result.deletedCount,
      timestamp: now,
    }
  }

  async pauseSession(sessionId) {
    if (!sessionId) throw new Error('Session ID required')

    const result = await this.uploadSessions.updateOne(
      { _id: sessionId },
      {
        $set: {
          state: UploadSessionState.PAUSED,
          lastActivityAt: new Date(),
        },
      }
    )

    return result.modifiedCount > 0
  }

  async resumeSession(sessionId, uploadToken) {
    if (!sessionId || !uploadToken) throw new Error('Session ID and token required')

    const session = await this.getSession(sessionId, uploadToken)

    if (session.state !== UploadSessionState.PAUSED) {
      throw new Error(`Cannot resume session in state: ${session.state}`)
    }

    const result = await this.uploadSessions.updateOne(
      { _id: sessionId },
      {
        $set: {
          state: UploadSessionState.IN_PROGRESS,
          lastActivityAt: new Date(),
        },
      }
    )

    return result.modifiedCount > 0
  }

  async getUploadUrl(sessionId, chunkIndex, credentials) {
    if (!sessionId || chunkIndex === undefined) {
      throw new Error('Session ID and chunk index required')
    }

    if (!credentials || !credentials.accessKey || !credentials.secretKey) {
      throw new Error('S3-compatible credentials required')
    }

    const session = await this.uploadSessions.findOne({ _id: sessionId })
    if (!session) throw new Error('Session not found')

    // In production, generate presigned URL using AWS SDK or S3-compatible service
    // This is a placeholder showing the structure
    const url = {
      sessionId,
      chunkIndex,
      uploadEndpoint: process.env.UPLOAD_ENDPOINT || 'https://storage.example.com/upload',
      method: 'PUT',
      headers: {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': credentials.accessKey,
        'X-Amz-Date': new Date().toISOString(),
        'X-Amz-Expires': '3600',
      },
      expiresIn: 3600,
    }

    return url
  }

  _generateToken(length = 32) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let token = ''
    for (let i = 0; i < length; i++) {
      token += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return token
  }
}

export async function computeChunkHash(chunkData, algorithm = 'sha256') {
  if (!chunkData) throw new Error('Chunk data required')

  const buffer = chunkData instanceof Buffer ? chunkData : Buffer.from(chunkData)
  return createHash(algorithm).update(buffer).digest('hex')
}

export async function validateChunkIntegrity(chunkData, expectedHash, algorithm = 'sha256') {
  if (!expectedHash) {
    return {
      valid: true,
      reason: 'No expected hash provided for validation',
    }
  }

  const computedHash = await computeChunkHash(chunkData, algorithm)

  if (computedHash === expectedHash) {
    return {
      valid: true,
      hash: computedHash,
    }
  }

  return {
    valid: false,
    reason: `Hash mismatch: expected ${expectedHash} but got ${computedHash}`,
    expected: expectedHash,
    computed: computedHash,
  }
}

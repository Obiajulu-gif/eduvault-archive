export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/api/audit'
import { withApiHardening } from '@/lib/api/hardening'
import { requireAdmin, requirePermission } from '@/lib/api/auth'
import { getDb } from '@/lib/mongodb'
import { pinata } from '@/lib/pinata'
import { createQuarantineRecord } from '@/lib/publishing/quarantine'
import { getClamAvSignatureVersion } from '@/lib/publishing/malwareScanner'
import { enqueueSideEffect } from '@/lib/backend/outbox'
import {
  cleanupExpiredUploads,
  createUploadSession,
  finalizeUploadSession,
  getUploadProgress,
  pauseUploadSession,
  recordUploadChunk,
  ResumableUploadError,
  resumeUploadSession,
} from '@/lib/storage/resumableUpload'

const BAD_REQUEST_CODES = new Set([
  'INVALID_FILE_NAME',
  'INVALID_FILE_SIZE',
  'INVALID_CHUNK_SIZE',
  'INVALID_MIME_TYPE',
  'INVALID_EXPECTED_HASH',
  'INVALID_CHUNK_INDEX',
  'INVALID_CHUNK_SIZE',
  'INVALID_SESSION_STATE',
  'CHUNK_HASH_MISMATCH',
  'INCOMPLETE_UPLOAD',
  'MISSING_CHUNK',
  'LENGTH_MISMATCH',
  'BYTE_HASH_MISMATCH',
  'MISSING_DEPENDENCY',
])

function statusForUploadError(error) {
  if (!(error instanceof ResumableUploadError)) return 500
  if (error.code === 'UNAUTHORIZED_UPLOAD') return 403
  if (error.code === 'SESSION_NOT_FOUND') return 404
  if (error.code === 'SESSION_EXPIRED') return 410
  if (error.code === 'SESSION_FINALIZED') return 409
  return BAD_REQUEST_CODES.has(error.code) ? 400 : 500
}

function errorResponse(error, event, metadata = {}) {
  const status = statusForUploadError(error)
  auditLog({
    event,
    route: 'upload/chunked',
    method: 'POST',
    status,
    reason: error.message,
    metadata,
  })
  return NextResponse.json(
    { error: error.message, code: error.code || 'UPLOAD_FAILED' },
    { status }
  )
}

async function authenticatedUploader(request) {
  const authorization = await requirePermission(request, 'creator:manage')
  if (!authorization.ok) return { authorization }
  return { authorization, uploader: authorization.user }
}

export async function POST(request) {
  return withApiHardening(
    request,
    { route: 'upload/chunked', rateLimit: { limit: 100, windowMs: 60_000 } },
    async () => {
      try {
        const db = await getDb()
        const action = request.nextUrl.searchParams.get('action')

        if (action === 'create-session') {
          const { uploader, authorization } = await authenticatedUploader(request)
          if (!uploader) return authorization.response || NextResponse.json({ error: 'Creator access required' }, { status: authorization.status })

          const body = await request.json()
          try {
            const session = await createUploadSession({
              db,
              uploader,
              metadata: {
                fileName: body.fileName,
                size: body.fileSize,
                chunkSize: body.chunkSize,
                mimeType: body.mimeType,
                expectedHash: body.expectedHash || body.fileHash,
              },
            })
            auditLog({
              event: 'upload_session_created',
              route: 'upload/chunked',
              method: 'POST',
              status: 201,
              metadata: { sessionId: session._id, totalChunks: session.totalChunks },
            })
            return NextResponse.json({
              success: true,
              sessionId: session._id,
              uploadToken: session.uploadToken,
              totalChunks: session.totalChunks,
              chunkSize: session.chunkSize,
              expiresIn: Math.round((session.expiresAt - new Date()) / 1000),
            }, { status: 201 })
          } catch (error) {
            return errorResponse(error, 'upload_session_create_failed')
          }
        }

        if (action === 'upload-chunk') {
          const { uploader, authorization } = await authenticatedUploader(request)
          if (!uploader) return authorization.response || NextResponse.json({ error: 'Creator access required' }, { status: authorization.status })

          const body = await request.json()
          const { sessionId, chunkIndex, uploadToken, chunkData, chunkHash } = body
          if (!sessionId || chunkIndex === undefined || !uploadToken) {
            return NextResponse.json({ error: 'Session ID, chunk index, and upload token required' }, { status: 400 })
          }
          if (typeof chunkData !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunkData)) {
            return NextResponse.json({ error: 'Base64 chunkData is required' }, { status: 400 })
          }

          try {
            const progress = await recordUploadChunk({
              db,
              sessionId,
              uploadToken,
              uploader,
              chunkIndex,
              chunkBytes: Buffer.from(chunkData, 'base64'),
              expectedChunkHash: chunkHash,
            })
            auditLog({
              event: 'chunk_uploaded',
              route: 'upload/chunked',
              method: 'POST',
              status: 200,
              metadata: { sessionId, chunkIndex, percentage: progress.percentage },
            })
            return NextResponse.json({ success: true, ...progress })
          } catch (error) {
            return errorResponse(error, 'chunk_upload_failed', { sessionId, chunkIndex })
          }
        }

        if (action === 'get-progress') {
          const { uploader, authorization } = await authenticatedUploader(request)
          if (!uploader) return authorization.response || NextResponse.json({ error: 'Creator access required' }, { status: authorization.status })

          const body = await request.json()
          const { sessionId, uploadToken } = body
          if (!sessionId || !uploadToken) {
            return NextResponse.json({ error: 'Session ID and upload token required' }, { status: 400 })
          }
          try {
            return NextResponse.json({
              success: true,
              ...await getUploadProgress({ db, sessionId, uploadToken, uploader }),
            })
          } catch (error) {
            return errorResponse(error, 'upload_progress_failed', { sessionId })
          }
        }

        if (action === 'pause-upload') {
          const { uploader, authorization } = await authenticatedUploader(request)
          if (!uploader) return authorization.response || NextResponse.json({ error: 'Creator access required' }, { status: authorization.status })

          const body = await request.json()
          const { sessionId, uploadToken } = body
          if (!sessionId || !uploadToken) {
            return NextResponse.json({ error: 'Session ID and upload token required' }, { status: 400 })
          }
          try {
            return NextResponse.json({
              success: true,
              ...await pauseUploadSession({ db, sessionId, uploadToken, uploader }),
            })
          } catch (error) {
            return errorResponse(error, 'upload_pause_failed', { sessionId })
          }
        }

        if (action === 'resume-upload') {
          const { uploader, authorization } = await authenticatedUploader(request)
          if (!uploader) return authorization.response || NextResponse.json({ error: 'Creator access required' }, { status: authorization.status })

          const body = await request.json()
          const { sessionId, uploadToken } = body
          if (!sessionId || !uploadToken) {
            return NextResponse.json({ error: 'Session ID and upload token required' }, { status: 400 })
          }
          try {
            return NextResponse.json({
              success: true,
              ...await resumeUploadSession({ db, sessionId, uploadToken, uploader }),
            })
          } catch (error) {
            return errorResponse(error, 'upload_resume_failed', { sessionId })
          }
        }

        if (action === 'finalize-upload') {
          const { uploader, authorization } = await authenticatedUploader(request)
          if (!uploader) return authorization.response || NextResponse.json({ error: 'Creator access required' }, { status: authorization.status })

          const body = await request.json()
          const { sessionId, uploadToken } = body
          if (!sessionId || !uploadToken) {
            return NextResponse.json({ error: 'Session ID and upload token required' }, { status: 400 })
          }

          try {
            const signatureVersion = await getClamAvSignatureVersion()
            const result = await finalizeUploadSession({
              db,
              sessionId,
              uploadToken,
              uploader,
              pinFn: async ({ bytes, fileName, mimeType }) => {
                const file = new File([bytes], fileName, { type: mimeType })
                const uploaded = await pinata.upload.public.file(file)
                return {
                  cid: uploaded.cid,
                  url: await pinata.gateways.public.convert(uploaded.cid),
                }
              },
              createQuarantineFn: (input) => createQuarantineRecord({ db, materialId: null, ...input }),
              enqueueScanFn: async ({ quarantine }) => {
                await enqueueSideEffect({
                  sourceAggregate: 'quarantine',
                  sourceId: quarantine.contentHash,
                  intent: {
                    type: 'indexer',
                    channel: 'scan_content',
                    action: 'scan_content',
                    payload: {
                      action: 'scan_content',
                      contentHash: quarantine.contentHash,
                      byteHash: quarantine.byteHash,
                      expectedByteHash: quarantine.byteHash,
                      sizeBytes: quarantine.sizeBytes,
                      mimeType: quarantine.mimeType,
                      scanner: signatureVersion ? 'clamav' : 'ipfs-fetch-scanner',
                      signatureVersion: signatureVersion || 'unversioned',
                    },
                  },
                })
              },
            })
            auditLog({
              event: 'upload_finalized',
              route: 'upload/chunked',
              method: 'POST',
              status: 200,
              metadata: { sessionId, cid: result.cid },
            })
            return NextResponse.json({ success: true, ...result })
          } catch (error) {
            return errorResponse(error, 'upload_finalization_failed', { sessionId })
          }
        }

        if (action === 'cleanup-expired') {
          const admin = await requireAdmin(request)
          if (!admin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
          const cleaned = await cleanupExpiredUploads({ db })
          return NextResponse.json({ success: true, ...cleaned })
        }

        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
      } catch (error) {
        auditLog({
          event: 'upload_chunked_error',
          route: 'upload/chunked',
          method: 'POST',
          status: 500,
          reason: error.message,
        })
        return NextResponse.json({ error: error.message || 'Upload failed' }, { status: 500 })
      }
    }
  )
}

export async function GET(request) {
  return withApiHardening(
    request,
    { route: 'upload/chunked', rateLimit: { limit: 50, windowMs: 60_000 } },
    async () => {
      const { uploader, authorization } = await authenticatedUploader(request)
      if (!uploader) return authorization.response || NextResponse.json({ error: 'Creator access required' }, { status: authorization.status })

      const sessionId = request.nextUrl.searchParams.get('sessionId')
      const uploadToken = request.nextUrl.searchParams.get('uploadToken')
      if (!sessionId || !uploadToken) {
        return NextResponse.json({ error: 'Session ID and upload token required' }, { status: 400 })
      }
      try {
        const db = await getDb()
        return NextResponse.json({
          success: true,
          ...await getUploadProgress({ db, sessionId, uploadToken, uploader }),
        })
      } catch (error) {
        return errorResponse(error, 'upload_progress_failed', { sessionId })
      }
    }
  )
}

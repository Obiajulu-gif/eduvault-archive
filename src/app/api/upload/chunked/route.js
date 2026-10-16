// Chunked upload API endpoint for large files (#740)
import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/api/audit'
import { withApiHardening } from '@/lib/api/hardening'
import { getDb } from '@/lib/mongodb'
import { UploadSessionManager, computeChunkHash, validateChunkIntegrity } from '@/lib/storage/chunkedUpload'

export const dynamic = 'force-dynamic'

export async function POST(request) {
  return withApiHardening(
    request,
    { route: 'upload/chunked', rateLimit: { limit: 100, windowMs: 60_000 } },
    async () => {
      try {
        const db = await getDb()
        const sessionManager = new UploadSessionManager(db)
        const action = request.nextUrl.searchParams.get('action')

        // Action: create-session
        if (action === 'create-session') {
          const body = await request.json()
          const {
            fileName,
            fileSize,
            chunkSize = 5 * 1024 * 1024, // 5MB default
            mimeType,
          } = body

          if (!fileName || !fileSize) {
            return NextResponse.json(
              { error: 'File name and size required' },
              { status: 400 }
            )
          }

          const totalChunks = Math.ceil(fileSize / chunkSize)
          const creatorAddress = request.headers.get('x-wallet-address') || 'anonymous'

          try {
            const session = await sessionManager.createSession(
              { fileName, size: fileSize, mimeType, chunkSize },
              {
                chunkSize,
                totalChunks,
                creatorAddress,
              }
            )

            auditLog({
              event: 'upload_session_created',
              route: 'upload/chunked',
              method: 'POST',
              status: 201,
              metadata: { sessionId: session._id, totalChunks },
            })

            return NextResponse.json(
              {
                success: true,
                sessionId: session._id,
                uploadToken: session.uploadToken,
                totalChunks,
                chunkSize,
                expiresIn: Math.round(
                  (session.expiresAt - new Date()) / 1000
                ),
              },
              { status: 201 }
            )
          } catch (error) {
            auditLog({
              event: 'upload_session_create_failed',
              route: 'upload/chunked',
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

        // Action: upload-chunk
        if (action === 'upload-chunk') {
          const { sessionId, chunkIndex, uploadToken } = await request.json()

          if (!sessionId || chunkIndex === undefined || !uploadToken) {
            return NextResponse.json(
              { error: 'Session ID, chunk index, and upload token required' },
              { status: 400 }
            )
          }

          try {
            const session = await sessionManager.getSession(sessionId, uploadToken)

            if (chunkIndex >= session.totalChunks || chunkIndex < 0) {
              return NextResponse.json(
                { error: `Invalid chunk index: ${chunkIndex}` },
                { status: 400 }
              )
            }

            // In production, this would receive the actual chunk data
            // For now, we record the metadata
            const chunkData = Buffer.alloc(0) // Placeholder
            const chunkHash = await computeChunkHash(chunkData)

            const progress = await sessionManager.recordChunkUpload(
              sessionId,
              chunkIndex,
              chunkHash,
              chunkData.length
            )

            auditLog({
              event: 'chunk_uploaded',
              route: 'upload/chunked',
              method: 'POST',
              status: 200,
              metadata: { sessionId, chunkIndex, percentage: progress.percentage },
            })

            return NextResponse.json({
              success: true,
              chunkIndex,
              uploadedBytes: progress.uploadedBytes,
              totalBytes: session.totalBytes,
              percentage: progress.percentage,
              completedChunks: progress.completedChunks,
            })
          } catch (error) {
            auditLog({
              event: 'chunk_upload_failed',
              route: 'upload/chunked',
              method: 'POST',
              status: 400,
              reason: error.message,
            })
            return NextResponse.json(
              { error: error.message },
              { status: 400 }
            )
          }
        }

        // Action: finalize-upload
        if (action === 'finalize-upload') {
          const { sessionId, uploadToken, fileHash } = await request.json()

          if (!sessionId || !uploadToken || !fileHash) {
            return NextResponse.json(
              { error: 'Session ID, upload token, and file hash required' },
              { status: 400 }
            )
          }

          try {
            const session = await sessionManager.getSession(sessionId, uploadToken)
            const verification = await sessionManager.verifyAndFinalizeSession(
              sessionId,
              fileHash
            )

            auditLog({
              event: 'upload_finalized',
              route: 'upload/chunked',
              method: 'POST',
              status: 200,
              metadata: { sessionId },
            })

            return NextResponse.json({
              success: true,
              sessionId,
              finalFileHash: verification.finalFileHash,
              manifestHash: verification.manifestHash,
              totalChunks: verification.totalChunks,
              totalBytes: verification.totalBytes,
              message: 'Upload verified and ready for pinning',
            })
          } catch (error) {
            auditLog({
              event: 'upload_finalization_failed',
              route: 'upload/chunked',
              method: 'POST',
              status: 400,
              reason: error.message,
            })
            return NextResponse.json(
              { error: error.message },
              { status: 400 }
            )
          }
        }

        // Action: get-progress
        if (action === 'get-progress') {
          const { sessionId } = await request.json()

          if (!sessionId) {
            return NextResponse.json(
              { error: 'Session ID required' },
              { status: 400 }
            )
          }

          try {
            const progress = await sessionManager.getSessionProgress(sessionId)
            return NextResponse.json({ success: true, ...progress })
          } catch (error) {
            return NextResponse.json(
              { error: error.message },
              { status: 404 }
            )
          }
        }

        // Action: pause-upload
        if (action === 'pause-upload') {
          const { sessionId } = await request.json()

          if (!sessionId) {
            return NextResponse.json(
              { error: 'Session ID required' },
              { status: 400 }
            )
          }

          try {
            const paused = await sessionManager.pauseSession(sessionId)
            return NextResponse.json({
              success: paused,
              message: paused ? 'Upload paused' : 'Failed to pause upload',
            })
          } catch (error) {
            return NextResponse.json(
              { error: error.message },
              { status: 400 }
            )
          }
        }

        // Action: resume-upload
        if (action === 'resume-upload') {
          const { sessionId, uploadToken } = await request.json()

          if (!sessionId || !uploadToken) {
            return NextResponse.json(
              { error: 'Session ID and upload token required' },
              { status: 400 }
            )
          }

          try {
            const resumed = await sessionManager.resumeSession(sessionId, uploadToken)
            return NextResponse.json({
              success: resumed,
              message: resumed ? 'Upload resumed' : 'Failed to resume upload',
            })
          } catch (error) {
            return NextResponse.json(
              { error: error.message },
              { status: 400 }
            )
          }
        }

        return NextResponse.json(
          { error: 'Unknown action' },
          { status: 400 }
        )
      } catch (error) {
        auditLog({
          event: 'upload_chunked_error',
          route: 'upload/chunked',
          method: 'POST',
          status: 500,
          reason: error.message,
        })
        return NextResponse.json(
          { error: error.message || 'Upload failed' },
          { status: 500 }
        )
      }
    }
  )
}

export async function GET(request) {
  return withApiHardening(
    request,
    { route: 'upload/chunked', rateLimit: { limit: 50, windowMs: 60_000 } },
    async () => {
      try {
        const db = await getDb()
        const sessionManager = new UploadSessionManager(db)

        const sessionId = request.nextUrl.searchParams.get('sessionId')
        if (!sessionId) {
          return NextResponse.json(
            { error: 'Session ID required' },
            { status: 400 }
          )
        }

        const progress = await sessionManager.getSessionProgress(sessionId)
        return NextResponse.json({ success: true, ...progress })
      } catch (error) {
        return NextResponse.json(
          { error: error.message },
          { status: 404 }
        )
      }
    }
  )
}

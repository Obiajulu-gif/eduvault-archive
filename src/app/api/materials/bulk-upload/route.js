export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/api/audit'
import { withApiHardening } from '@/lib/api/hardening'
import { validateUploadedFile } from '@/lib/ipfs/uploadValidator'
import { pinata } from '@/lib/pinata'
import { getDb } from '@/lib/mongodb'
import { enqueueSideEffect } from '@/lib/backend/outbox'
import { createQuarantineRecord } from '@/lib/publishing/quarantine'

const MAX_FILES_PER_BATCH = 10
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB per file

const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
  'image/jpeg',
  'image/png',
  'image/webp',
]

/**
 * POST /api/materials/bulk-upload
 * Handles concurrent batch uploads of up to 10 files to Pinata IPFS storage.
 * 
 * Space & Time Complexity:
 * - Time Complexity: O(N * M) total where N is the number of files (N <= 10) and M is file size validation byte inspection.
 *   Network I/O pinning to Pinata runs in parallel (Promise.allSettled) in O(max(File_Upload_Time_i)) time.
 * - Space Complexity: O(N * M) buffer storage held in memory during request processing.
 */
export async function POST(request) {
  return withApiHardening(
    request,
    { route: 'materials/bulk-upload', rateLimit: { limit: 10, windowMs: 60_000 } },
    async () => {
      try {
        const form = await request.formData()
        const files = form.getAll('files')

        if (!files || files.length === 0) {
          auditLog({
            event: 'bulk_upload_failed',
            route: 'materials/bulk-upload',
            method: 'POST',
            status: 400,
            reason: 'no_files_provided',
          })
          return NextResponse.json(
            { error: 'No files provided in request. Expecting form field "files".' },
            { status: 400 }
          )
        }

        if (files.length > MAX_FILES_PER_BATCH) {
          auditLog({
            event: 'bulk_upload_failed',
            route: 'materials/bulk-upload',
            method: 'POST',
            status: 400,
            reason: 'exceeded_max_file_limit',
          })
          return NextResponse.json(
            { error: `Batch upload limit exceeded. Maximum allowed files per batch is ${MAX_FILES_PER_BATCH}.` },
            { status: 400 }
          )
        }

        // Validate each file before initiation to avoid partial work on bad payloads
        const validationErrors = []
        for (let i = 0; i < files.length; i++) {
          const file = files[i]

          if (!(file instanceof File) || typeof file.arrayBuffer !== 'function') {
            validationErrors.push({ index: i, name: file?.name || `file_${i}`, error: 'Invalid file object' })
            continue
          }

          if (file.size > MAX_FILE_SIZE_BYTES) {
            const sizeMB = (file.size / (1024 * 1024)).toFixed(2)
            validationErrors.push({
              index: i,
              name: file.name,
              error: `File size (${sizeMB}MB) exceeds maximum limit of 10MB`,
            })
            continue
          }

          if (file.type && !ALLOWED_FILE_TYPES.includes(file.type)) {
            validationErrors.push({
              index: i,
              name: file.name,
              error: `Unsupported file type: ${file.type}`,
            })
            continue
          }

          const fileCheck = await validateUploadedFile(file, ALLOWED_FILE_TYPES)
          if (!fileCheck.valid) {
            validationErrors.push({
              index: i,
              name: file.name,
              error: fileCheck.reason || 'File magic number validation failed',
            })
          }
        }

        if (validationErrors.length > 0) {
          auditLog({
            event: 'bulk_upload_failed',
            route: 'materials/bulk-upload',
            method: 'POST',
            status: 422,
            reason: 'file_validation_failures',
          })
          return NextResponse.json(
            {
              error: 'One or more files failed validation checks prior to processing.',
              details: validationErrors,
            },
            { status: 422 }
          )
        }

        // Concurrent upload execution via Promise.allSettled
        const uploadPromises = files.map(async (file, index) => {
          const uploadedFile = await pinata.upload.public.file(file)
          const gatewayUrl = await pinata.gateways.public.convert(uploadedFile.cid)
          const uploaderAddress = request.headers.get('x-wallet-address') || 'anonymous'
          const db = await getDb()
          const quarantine = await createQuarantineRecord({
            db,
            contentHash: uploadedFile.cid,
            fileName: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            uploaderAddress,
            materialId: null,
          })

          await enqueueSideEffect({
            sourceAggregate: 'quarantine',
            sourceId: quarantine.contentHash,
            intent: {
              type: 'indexer',
              channel: 'scan_content',
              payload: {
                contentHash: quarantine.contentHash,
                fileName: quarantine.fileName,
                mimeType: quarantine.mimeType,
                sizeBytes: quarantine.sizeBytes,
                action: 'scan',
              },
            },
          })

          return {
            index,
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type,
            cid: uploadedFile.cid,
            contentHash: quarantine.contentHash,
            quarantineState: quarantine.state,
            url: gatewayUrl,
          }
        })

        const results = await Promise.allSettled(uploadPromises)

        const filesProcessed = []
        const uploadFailures = []

        results.forEach((result, idx) => {
          if (result.status === 'fulfilled') {
            filesProcessed.push(result.value)
          } else {
            uploadFailures.push({
              index: idx,
              fileName: files[idx].name,
              error: result.reason?.message || 'Upload pin failed',
            })
          }
        })

        auditLog({
          event: 'bulk_upload_completed',
          route: 'materials/bulk-upload',
          method: 'POST',
          status: 200,
          totalFiles: files.length,
          successfulUploads: filesProcessed.length,
          failedUploads: uploadFailures.length,
        })

        return NextResponse.json(
          {
            success: true,
            total: files.length,
            uploadedCount: filesProcessed.length,
            files: filesProcessed,
            failures: uploadFailures,
          },
          { status: 200 }
        )
      } catch (err) {
        auditLog({
          event: 'bulk_upload_failed',
          route: 'materials/bulk-upload',
          method: 'POST',
          status: 500,
          reason: err.message,
        })
        return NextResponse.json(
          { error: err.message || 'Internal server error during bulk upload processing' },
          { status: 500 }
        )
      }
    }
  )
}

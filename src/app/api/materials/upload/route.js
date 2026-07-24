export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/api/audit'
import { withApiHardening } from '@/lib/api/hardening'
import {
  normalizeStringList,
  normalizeImageField,
  sanitizeObject,
  validateUploadPayload,
  validateUploadFileMetadata,
} from '@/lib/api/validation'
import { pinata } from '@/lib/pinata'
import { validateUploadedFile } from '@/lib/ipfs/uploadValidator'

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB
const MAX_THUMBNAIL_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB

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
]

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export async function POST(request) {
  return withApiHardening(
    request,
    { route: 'materials/upload', rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      try {
        const form = await request.formData()
        const file = form.get('file')
        const image = form.get('thumbnail')

        // 1. Require a document file
        if (!file) {
          auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 400, reason: 'missing_file' })
          return NextResponse.json({ error: 'No document file provided.' }, { status: 400 })
        }

        // 2. Size check — fast path before reading bytes
        if (file.size > MAX_FILE_SIZE_BYTES) {
          const sizeMB = (file.size / (1024 * 1024)).toFixed(2)
          auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 413, reason: 'file_too_large' })
          return NextResponse.json({ error: `File size (${sizeMB}MB) exceeds the 10MB limit.` }, { status: 413 })
        }

        // 3. MIME type allowlist check
        if (!ALLOWED_FILE_TYPES.includes(file.type)) {
          auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 415, reason: 'unsupported_file_type' })
          return NextResponse.json(
            { error: `Unsupported file type: ${file.type || 'unknown'}. Allowed types include PDF, Word, Excel, PPT, TXT, and ZIP.` },
            { status: 415 }
          )
        }

        // 4. Magic number / byte-stream validation — blocks spoofed mimetypes
        const fileCheck = await validateUploadedFile(file, ALLOWED_FILE_TYPES)
        if (!fileCheck.valid) {
          auditLog({ event: 'upload_blocked', route: 'materials/upload', method: 'POST', status: 422, reason: fileCheck.reason })
          return NextResponse.json({ error: fileCheck.reason }, { status: 422 })
        }

        // 5. Thumbnail validation
        if (image) {
          if (image.size > MAX_THUMBNAIL_SIZE_BYTES) {
            const sizeMB = (image.size / (1024 * 1024)).toFixed(2)
            auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 413, reason: 'thumbnail_too_large' })
            return NextResponse.json({ error: `Thumbnail size (${sizeMB}MB) exceeds the 5MB limit.` }, { status: 413 })
          }

          if (!ALLOWED_IMAGE_TYPES.includes(image.type)) {
            auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 415, reason: 'unsupported_thumbnail_type' })
            return NextResponse.json(
              { error: `Unsupported thumbnail type: ${image.type || 'unknown'}. Allowed types are JPG, PNG, and WEBP.` },
              { status: 415 }
            )
          }

          const imgCheck = await validateUploadedFile(image, ALLOWED_IMAGE_TYPES)
          if (!imgCheck.valid) {
            auditLog({ event: 'upload_blocked', route: 'materials/upload', method: 'POST', status: 422, reason: imgCheck.reason })
            return NextResponse.json({ error: imgCheck.reason }, { status: 422 })
          }
        }

        // 6. Structured metadata validation
        try {
          validateUploadFileMetadata(file, 'file')
        } catch (validationErr) {
          auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 400, reason: validationErr.message })
          return NextResponse.json({ error: validationErr.message }, { status: 400 })
        }

        const metadataPayload = {
          title: form.get('title') || form.get('name'),
          description: form.get('description'),
          price: form.get('price'),
          usageRights: form.get('usageRights'),
          visibility: form.get('visibility'),
        }

        try {
          validateUploadPayload(metadataPayload)
        } catch (validationErr) {
          auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 400, reason: validationErr.message })
          return NextResponse.json({ error: validationErr.message }, { status: 400 })
        }

        // All checks passed — dispatch to Pinata
        const results = {}

        const uploadedFile = await pinata.upload.public.file(file)
        const fileUrl = await pinata.gateways.public.convert(uploadedFile.cid)
        results.fileUrl = fileUrl

        if (image) {
          const fileThumb = await pinata.upload.public.file(image)
          const imgUrl = await pinata.gateways.public.convert(fileThumb.cid)
          results.imgUrl = imgUrl
        }

        const otherFields = {}
        for (const [key, value] of form.entries()) {
          if (key !== 'file' && key !== 'thumbnail') {
            otherFields[key] = value
          }
        }

        const previewInputs = {
          learningOutcomes: otherFields.learningOutcomes,
          tableOfContents: otherFields.tableOfContents,
          sampleNotes: otherFields.sampleNotes,
        }
        const scalarFields = { ...otherFields }
        delete scalarFields.learningOutcomes
        delete scalarFields.tableOfContents
        delete scalarFields.sampleNotes

        const sanitizedScalarFields = sanitizeObject(scalarFields, {
          title: 160,
          description: 5000,
          shortSummary: 280,
          usageRights: 1000,
          coverImageUrl: 2048,
          thumbnailUrl: 2048,
        })

        const metadataJSON = {
          name: sanitizedScalarFields.title || sanitizedScalarFields.name || "",
          description: sanitizedScalarFields.description || "",
          image: results.imgUrl || null,
          properties: {
            ...sanitizedScalarFields,
            coverImageUrl: results.imgUrl || sanitizedScalarFields.coverImageUrl || null,
            thumbnailUrl: results.imgUrl || sanitizedScalarFields.thumbnailUrl || null,
            learningOutcomes: normalizeStringList(previewInputs.learningOutcomes, { maxItems: 8, maxLength: 180 }),
            tableOfContents: normalizeStringList(previewInputs.tableOfContents, { maxItems: 16, maxLength: 180 }),
            sampleNotes: normalizeStringList(previewInputs.sampleNotes, { maxItems: 6, maxLength: 280 }),
            storageKey: uploadedFile.cid,
            fileUrl: results.fileUrl,
            timestamp: new Date().toISOString(),
          },
          ...sanitizedScalarFields,
          coverImageUrl: results.imgUrl || normalizeImageField(sanitizedScalarFields.coverImageUrl, 'coverImageUrl'),
          thumbnailUrl: results.imgUrl || normalizeImageField(sanitizedScalarFields.thumbnailUrl, 'thumbnailUrl'),
          learningOutcomes: normalizeStringList(previewInputs.learningOutcomes, { maxItems: 8, maxLength: 180 }),
          tableOfContents: normalizeStringList(previewInputs.tableOfContents, { maxItems: 16, maxLength: 180 }),
          sampleNotes: normalizeStringList(previewInputs.sampleNotes, { maxItems: 6, maxLength: 280 }),
          storageKey: uploadedFile.cid,
          fileUrl: results.fileUrl,
          image: results.imgUrl || null,
          timestamp: new Date().toISOString(),
        }

        const uploadedJson = await pinata.upload.public.json(metadataJSON)
        const jsonUrl = await pinata.gateways.public.convert(uploadedJson.cid)
        results.metadataUrl = jsonUrl

        auditLog({ event: 'upload_complete', route: 'materials/upload', method: 'POST', status: 200 })

        return NextResponse.json({
          success: true,
          storageKey: uploadedFile.cid,
          image: results.imgUrl || '',
          metadata: results.metadataUrl,
        })
      } catch (err) {
        auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 500, reason: err.message })
        return NextResponse.json({ error: err.message || 'Upload failed' }, { status: 500 })
      }
    }
  )
}

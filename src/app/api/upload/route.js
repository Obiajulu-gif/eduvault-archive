import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/api/audit'
import { withApiHardening } from '@/lib/api/hardening'
import { sanitizeObject } from '@/lib/api/validation'
import { pinata } from '@/lib/pinata'

export const dynamic = 'force-dynamic'

// --- Validation Constants ---
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10MB
const MAX_THUMBNAIL_SIZE_BYTES = 5 * 1024 * 1024 // 5MB

// Common educational document MIME types
const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'application/msword', // .doc
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.ms-excel', // .xls
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-powerpoint', // .ppt
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
]

// Allowed thumbnail image types
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export async function POST(request) {
  return withApiHardening(
    request,
    { route: 'upload', rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      try {
        const form = await request.formData()
        const file = form.get('file')
        const image = form.get('thumbnail')

        // 1️⃣ Validate Required Fields
        if (!file) {
          auditLog({
            event: 'upload_failed',
            route: 'upload',
            method: 'POST',
            status: 400,
            reason: 'missing_file',
          })
          return NextResponse.json(
            { error: 'No document file provided.' },
            { status: 400 }
          )
        }

        // 2️⃣ Validate Main File (Size & Type)
        if (file.size > MAX_FILE_SIZE_BYTES) {
          const sizeMB = (file.size / (1024 * 1024)).toFixed(2)
          auditLog({
            event: 'upload_failed',
            route: 'upload',
            method: 'POST',
            status: 413,
            reason: 'file_too_large',
          })
          return NextResponse.json(
            {
              error: `File size (${sizeMB}MB) exceeds the 10MB limit.`,
            },
            { status: 413 }
          )
        }

        if (!ALLOWED_FILE_TYPES.includes(file.type)) {
          auditLog({
            event: 'upload_failed',
            route: 'upload',
            method: 'POST',
            status: 415,
            reason: 'unsupported_file_type',
          })
          return NextResponse.json(
            {
              error: `Unsupported file type: ${file.type || 'unknown'}. Allowed types include PDF, Word, Excel, PPT, TXT, and ZIP.`,
            },
            { status: 415 }
          )
        }

        // 3️⃣ Validate Thumbnail (Size & Type) - If provided
        if (image) {
          if (image.size > MAX_THUMBNAIL_SIZE_BYTES) {
            const sizeMB = (image.size / (1024 * 1024)).toFixed(2)
            auditLog({
              event: 'upload_failed',
              route: 'upload',
              method: 'POST',
              status: 413,
              reason: 'thumbnail_too_large',
            })
            return NextResponse.json(
              {
                error: `Thumbnail size (${sizeMB}MB) exceeds the 5MB limit.`,
              },
              { status: 413 }
            )
          }

          if (!ALLOWED_IMAGE_TYPES.includes(image.type)) {
            auditLog({
              event: 'upload_failed',
              route: 'upload',
              method: 'POST',
              status: 415,
              reason: 'unsupported_thumbnail_type',
            })
            return NextResponse.json(
              {
                error: `Unsupported thumbnail type: ${image.type || 'unknown'}. Allowed types are JPG, PNG, and WEBP.`,
              },
              { status: 415 }
            )
          }
        }

        const results = {}

        // 4️⃣ Upload the main file
        const uploadedFile = await pinata.upload.public.file(file)
        const fileUrl = await pinata.gateways.public.convert(uploadedFile.cid)
        results.fileUrl = fileUrl

        // 5️⃣ Upload thumbnail (if provided)
        if (image) {
          const fileThumb = await pinata.upload.public.file(image)
          const imgUrl = await pinata.gateways.public.convert(fileThumb.cid)
          results.imgUrl = imgUrl
        }

        // 6️⃣ Prepare the rest of the form data as JSON
        const otherFields = {}
        for (const [key, value] of form.entries()) {
          if (key !== 'file' && key !== 'thumbnail') {
            otherFields[key] = value
          }
        }
        const sanitizedFields = sanitizeObject(otherFields, {
          title: 160,
          description: 5000,
          usageRights: 1000,
        })

        // Include storage reference inside the metadata
        const metadataJSON = {
          ...sanitizedFields,
          storageKey: uploadedFile.cid,
          image: results.imgUrl || null,
          timestamp: new Date().toISOString(),
        }
        auditLog({
          event: 'upload_metadata_prepared',
          route: 'upload',
          method: 'POST',
          status: 200,
        })

        // 7️⃣ Upload metadata JSON to Pinata
        const uploadedJson = await pinata.upload.public.json(metadataJSON)
        const jsonUrl = await pinata.gateways.public.convert(uploadedJson.cid)
        results.metadataUrl = jsonUrl

        auditLog({
          event: 'upload_complete',
          route: 'upload',
          method: 'POST',
          status: 200,
        })

        // 8️⃣ Return the CID as storageKey
        return NextResponse.json({
          success: true,
          storageKey: uploadedFile.cid,
          image: results.imgUrl || '',
          metadata: results.metadataUrl,
        })
      } catch (err) {
        auditLog({
          event: 'upload_failed',
          route: 'upload',
          method: 'POST',
          status: 500,
          reason: err.message,
        })
        return NextResponse.json(
          { error: err.message || 'Upload failed' },
          { status: 500 }
        )
      }
    }
  )
}

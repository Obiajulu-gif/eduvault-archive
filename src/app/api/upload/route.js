// Resolves #430: Implement a secure API route that receives file uploads and pins them to IPFS via Pinata.
import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/api/audit'
import { withApiHardening } from '@/lib/api/hardening'
import { normalizeStringList, sanitizeObject, validateUploadPayload, validateUploadFileMetadata } from '@/lib/api/validation'
import { pinata } from '@/lib/pinata'
import { validatePinataResponse, validateGatewayUrl, retryWithBackoff } from '@/lib/api/storage'
import { sanitizeRichText, isSafeUrl } from '@/lib/api/contentSanitizer'
import { guardZipArchiveUpload } from '@/lib/backend/archiveUploadGuard'
import { validateUploadedFile, detectExecutableExtension } from '@/lib/ipfs/uploadValidator'
import { createQuarantineRecord } from '@/lib/publishing/quarantine'
import { enqueueSideEffect } from '@/lib/backend/outbox'
import { getDb } from '@/lib/mongodb'

export const dynamic = 'force-dynamic'

// --- Validation Constants ---
const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024 // 10MB
const MAX_VIDEO_SIZE_BYTES = 2 * 1024 * 1024 * 1024 // 2GB
const MAX_THUMBNAIL_SIZE_BYTES = 5 * 1024 * 1024 // 5MB

// Common educational document MIME types
const ALLOWED_DOCUMENT_TYPES = [
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

// Allowed video MIME types for educational content
const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/ogg',
  'video/x-matroska',
]

const ALLOWED_FILE_TYPES = [...ALLOWED_DOCUMENT_TYPES, ...ALLOWED_VIDEO_TYPES]

// Allowed thumbnail image types
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

const RETRY_ATTEMPTS = 3
const RETRY_DELAY_MS = 1000

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
          auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 400, reason: 'missing_file' })
          return NextResponse.json({ error: 'No document file provided.' }, { status: 400 })
        }

        // 2️⃣ Validate Main File (Size & Type)
        const isVideo = ALLOWED_VIDEO_TYPES.includes(file.type)
        const maxFileSize = isVideo ? MAX_VIDEO_SIZE_BYTES : MAX_DOCUMENT_SIZE_BYTES
        const maxSizeMB = isVideo ? 2048 : 10

        if (file.size > maxFileSize) {
          const sizeMB = (file.size / (1024 * 1024)).toFixed(2)
          auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 413, reason: 'file_too_large' })
          return NextResponse.json({ error: `File size (${sizeMB}MB) exceeds the 10MB limit.` }, { status: 413 })
        }

        if (!ALLOWED_FILE_TYPES.includes(file.type)) {
          auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 415, reason: 'unsupported_file_type' })
          return NextResponse.json(
            { error: `Unsupported file type: ${file.type || 'unknown'}. Allowed types include PDF, Word, Excel, PPT, TXT, and ZIP.` },
            { status: 415 }
          )
        }

        // 2.1️⃣ Reject files whose *name* carries an executable/script extension
        // (issue #671). The MIME check above is spoofable (declared type +
        // magic number can both be forged, e.g. polyglot files), so blocking the
        // extension is a cheap defense-in-depth gate before any pin occurs.
        const executableCheck = detectExecutableExtension(file)
        if (executableCheck.blocked) {
          auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 415, reason: 'executable_extension' })
          return NextResponse.json({ error: executableCheck.reason }, { status: 415 })
        }

        // 2.2️⃣ Validate magic number (deep content sniffing) so the declared
        // MIME type matches the actual file bytes. Bypasses extension-only
        // spoofing: a renamed .exe will fail its magic-mismatch check here.
        try {
          const fileCheck = await validateUploadedFile(file, ALLOWED_FILE_TYPES)
          if (!fileCheck.valid) {
            auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 422, reason: 'file_magic_mismatch' })
            return NextResponse.json(
              { error: fileCheck.reason || 'File contents do not match its declared type.' },
              { status: 422 }
            )
          }
        } catch (magicErr) {
          auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 500, reason: `magic_validation_failure: ${magicErr.message}` })
          return NextResponse.json({ error: 'Failed to validate file contents.' }, { status: 500 })
        }

        // 3️⃣ Validate Thumbnail (Size & Type) - If provided
        if (image) {
          if (image.size > MAX_THUMBNAIL_SIZE_BYTES) {
            const sizeMB = (image.size / (1024 * 1024)).toFixed(2)
            auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 413, reason: 'thumbnail_too_large' })
            return NextResponse.json({ error: `Thumbnail size (${sizeMB}MB) exceeds the 5MB limit.` }, { status: 413 })
          }

          if (!ALLOWED_IMAGE_TYPES.includes(image.type)) {
            auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 415, reason: 'unsupported_thumbnail_type' })
            return NextResponse.json(
              { error: `Unsupported thumbnail type: ${image.type || 'unknown'}. Allowed types are JPG, PNG, and WEBP.` },
              { status: 415 }
            )
          }
        }

        // 3.5️⃣ Validate file metadata with structured validation
        try {
          validateUploadFileMetadata(file, 'file')
        } catch (validationErr) {
          auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 400, reason: validationErr.message })
          return NextResponse.json({ error: validationErr.message }, { status: 400 })
        }

        // 3.55️⃣ For zip uploads specifically, guard against path traversal,
        // symlinks, nested archives, and decompression bombs (issue #639)
        // before the archive is ever pinned to IPFS as-is.
        try {
          const archiveCheck = await guardZipArchiveUpload(file)
          if (!archiveCheck.safe) {
            auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 422, reason: `archive_rejected:${archiveCheck.reason}` })
            return NextResponse.json(
              { error: `Archive rejected: ${archiveCheck.reason.replace(/_/g, ' ')}.` },
              { status: 422 }
            )
          }
        } catch (archiveErr) {
          auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 500, reason: `archive_check_failure: ${archiveErr.message}` })
          return NextResponse.json({ error: 'Failed to validate archive contents.' }, { status: 500 })
        }

        // 3.6️⃣ Validate upload metadata fields
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
          auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 400, reason: validationErr.message })
          return NextResponse.json({ error: validationErr.message }, { status: 400 })
        }

        const results = {}

        // 4️⃣ Upload the main file (with bounded retry/backoff)
        try {
          const uploadedFile = await retryWithBackoff(
            () => pinata.upload.public.file(file),
            RETRY_ATTEMPTS,
            RETRY_DELAY_MS,
            (err, attempt) => console.warn(`[Storage] Document upload attempt ${attempt} failed: ${err.message}`)
          )
          validatePinataResponse(uploadedFile, 'document')

          const fileUrl = await retryWithBackoff(
            () => pinata.gateways.public.convert(uploadedFile.cid),
            RETRY_ATTEMPTS,
            RETRY_DELAY_MS,
            (err, attempt) => console.warn(`[Storage] Document gateway conversion attempt ${attempt} failed: ${err.message}`)
          )
          validateGatewayUrl(fileUrl, 'document')
          results.fileUrl = fileUrl
          results.storageKey = uploadedFile.cid

          // 4.1️⃣ Quarantine gate (issue #671): every newly pinned document is
          // enrolled in a quarantine record as `pending` and a malware-scan
          // side-effect is enqueued. The material will not surface on the
          // marketplace until the scanner flips it to `clean`. If scanning is
          // unavailable the record stays pending (fail-closed) and the material
          // remains hidden rather than being published unsafely.
          try {
            const db = await getDb()
            const uploaderAddress = request.headers.get('x-wallet-address') || 'anonymous'
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
            results.quarantineState = quarantine.state
          } catch (quarantineErr) {
            auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 500, reason: `quarantine_enrollment_failure: ${quarantineErr.message}` })
            // Fail closed: refuse to publish the CID that we could not
            // quarantine-track, so it can never bypass the listing gate.
            return NextResponse.json(
              { error: 'Failed to enroll upload for safety review. Please retry.' },
              { status: 500 }
            )
          }
        } catch (err) {
          auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 500, reason: `document_upload_failure: ${err.message}` })
          return NextResponse.json({ error: `Failed to upload document to storage: ${err.message}` }, { status: 500 })
        }

        // 5️⃣ Upload thumbnail (if provided)
        if (image) {
          try {
            const fileThumb = await retryWithBackoff(
              () => pinata.upload.public.file(image),
              RETRY_ATTEMPTS,
              RETRY_DELAY_MS,
              (err, attempt) => console.warn(`[Storage] Thumbnail upload attempt ${attempt} failed: ${err.message}`)
            )
            validatePinataResponse(fileThumb, 'thumbnail')

            const imgUrl = await retryWithBackoff(
              () => pinata.gateways.public.convert(fileThumb.cid),
              RETRY_ATTEMPTS,
              RETRY_DELAY_MS,
              (err, attempt) => console.warn(`[Storage] Thumbnail gateway conversion attempt ${attempt} failed: ${err.message}`)
            )
            validateGatewayUrl(imgUrl, 'thumbnail')
            results.imgUrl = imgUrl
          } catch (err) {
            auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 500, reason: `thumbnail_upload_failure: ${err.message}` })
            return NextResponse.json({ error: `Failed to upload thumbnail to storage: ${err.message}` }, { status: 500 })
          }
          }

        // 6️⃣ Prepare the rest of the form data as JSON metadata
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

        // Defense-in-depth (issue #649): sanitizeObject above only strips
        // control characters, it does not strip HTML — there's no rendering
        // path today that injects these fields as raw HTML (they render as
        // plain, React-escaped JSX text), but description is exactly the
        // kind of free-form field that's likely to grow rich-text rendering
        // later, and coverImageUrl/thumbnailUrl are attacker-controlled
        // strings that could otherwise carry a javascript:/data: scheme.
        if (sanitizedScalarFields.description) {
          sanitizedScalarFields.description = sanitizeRichText(sanitizedScalarFields.description)
        }
        for (const urlField of ['coverImageUrl', 'thumbnailUrl']) {
          if (sanitizedScalarFields[urlField] && !isSafeUrl(sanitizedScalarFields[urlField])) {
            auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 400, reason: `unsafe_url_scheme:${urlField}` })
            return NextResponse.json({ error: `Invalid ${urlField}: unsupported URL scheme.` }, { status: 400 })
          }
        }

        const metadataJSON = {
          name: sanitizedScalarFields.title || sanitizedScalarFields.name || '',
          description: sanitizedScalarFields.description || '',
          image: results.imgUrl || null,
          properties: {
            ...sanitizedScalarFields,
            coverImageUrl: results.imgUrl || sanitizedScalarFields.coverImageUrl || null,
            thumbnailUrl: results.imgUrl || sanitizedScalarFields.thumbnailUrl || null,
            learningOutcomes: normalizeStringList(previewInputs.learningOutcomes, { maxItems: 8, maxLength: 180 }),
            tableOfContents: normalizeStringList(previewInputs.tableOfContents, { maxItems: 16, maxLength: 180 }),
            sampleNotes: normalizeStringList(previewInputs.sampleNotes, { maxItems: 6, maxLength: 280 }),
            storageKey: results.storageKey,
            fileUrl: results.fileUrl,
            timestamp: new Date().toISOString(),
          },
          ...sanitizedScalarFields,
          coverImageUrl: results.imgUrl || sanitizedScalarFields.coverImageUrl || null,
          thumbnailUrl: results.imgUrl || sanitizedScalarFields.thumbnailUrl || null,
          learningOutcomes: normalizeStringList(previewInputs.learningOutcomes, { maxItems: 8, maxLength: 180 }),
          tableOfContents: normalizeStringList(previewInputs.tableOfContents, { maxItems: 16, maxLength: 180 }),
          sampleNotes: normalizeStringList(previewInputs.sampleNotes, { maxItems: 6, maxLength: 280 }),
          storageKey: results.storageKey,
          fileUrl: results.fileUrl,
          timestamp: new Date().toISOString(),
        }

        auditLog({ event: 'upload_metadata_prepared', route: 'upload', method: 'POST', status: 200 })

        // 7️⃣ Upload metadata JSON to Pinata (with bounded retry/backoff)
        try {
          const uploadedJson = await retryWithBackoff(
            () => pinata.upload.public.json(metadataJSON),
            RETRY_ATTEMPTS,
            RETRY_DELAY_MS,
            (err, attempt) => console.warn(`[Storage] Metadata upload attempt ${attempt} failed: ${err.message}`)
          )
          validatePinataResponse(uploadedJson, 'metadata')

          const jsonUrl = await retryWithBackoff(
            () => pinata.gateways.public.convert(uploadedJson.cid),
            RETRY_ATTEMPTS,
            RETRY_DELAY_MS,
            (err, attempt) => console.warn(`[Storage] Metadata gateway conversion attempt ${attempt} failed: ${err.message}`)
          )
          validateGatewayUrl(jsonUrl, 'metadata')
          results.metadataUrl = jsonUrl
        } catch (err) {
          auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 500, reason: `metadata_upload_failure: ${err.message}` })
          return NextResponse.json({ error: `Failed to publish metadata to storage: ${err.message}` }, { status: 500 })
        }
        auditLog({ event: 'upload_complete', route: 'upload', method: 'POST', status: 200 })

        // 8️⃣ Return the CID as storageKey plus URLs for backwards-compatibility
        return NextResponse.json({
          success: true,
          storageKey: results.storageKey || (uploadedFile && uploadedFile.cid),
          fileUrl: results.fileUrl,
          image: results.imgUrl || '',
          metadata: results.metadataUrl,
          quarantineState: results.quarantineState || null,
        })
      } catch (err) {
        auditLog({ event: 'upload_failed', route: 'upload', method: 'POST', status: 500, reason: err.message })
        return NextResponse.json({ error: err.message || 'Upload failed' }, { status: 500 })
      }
    }
  )
}

// Resolves: Implement a secure API route that receives file uploads and pins them to IPFS via Pinata.
import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/api/audit'
import { withApiHardening } from '@/lib/api/hardening'
import {
  normalizeStringList,
  normalizeImageField,
  sanitizeObject,
  validateUploadFileMetadata,
  validateUploadPayload,
} from '@/lib/api/validation'
import {
  retryWithBackoff,
  validateGatewayUrl,
  validatePinataResponse,
} from '@/lib/api/storage'
import { getDb } from '@/lib/mongodb'
import { pinata } from '@/lib/pinata'
import { storeManifest } from '@/lib/provenance/registry'
import { hashFileBytes } from '@/lib/provenance/manifest'
import { validateUploadedFile } from '@/lib/ipfs/uploadValidator'
import { quarantineUpload } from '@/lib/uploads/quarantine'

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

export const dynamic = 'force-dynamic'

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

        // 2️⃣ Validate Thumbnail (Size & Type) - If provided
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

        // 3.5️⃣ Validate file metadata with structured validation
        try {
          validateUploadFileMetadata(file, "file")
        } catch (validationErr) {
          auditLog({
            event: "upload_failed",
            route: "upload",
            method: "POST",
            status: 400,
            reason: validationErr.message,
          })
          return NextResponse.json(
            { error: validationErr.message },
            { status: 400 }
          )
        }

        // 3.6️⃣ Validate upload metadata fields
        const metadataPayload = {
          title: form.get("title") || form.get("name"),
          description: form.get("description"),
          price: form.get("price"),
          usageRights: form.get("usageRights"),
          visibility: form.get("visibility"),
        }

        try {
          validateUploadPayload(metadataPayload)
        } catch (validationErr) {
          auditLog({
            event: "upload_failed",
            route: "upload",
            method: "POST",
            status: 400,
            reason: validationErr.message,
          })
          return NextResponse.json(
            { error: validationErr.message },
            { status: 400 }
          )
        }

        // 3.6️⃣ Byte-level validation
        const byteValidation = await validateUploadedFile(file, ALLOWED_FILE_TYPES);
        if (!byteValidation.valid) {
          return NextResponse.json(
            { error: byteValidation.reason, status: 415, reason: "content_type_mismatch" }
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

        const fileBuffer = Buffer.from(await file.arrayBuffer());
        const db = await getDb();
        const quarantined = await quarantineUpload(db, {
          bytes: fileBuffer, fileName: file.name, mimeType: file.type,
          metadata: { title: form.get("title") || form.get("name") },
        });
        if (quarantined.status !== "approved") {
          auditLog({
            event: "upload_quarantined",
            action: "scan",
            resource: "upload",
            route: "upload",
            method: "POST",
            status: 202,
            outcome: quarantined.status,
            uploadId: String(quarantined._id),
          });
          return NextResponse.json(
            { success: true, uploadId: String(quarantined._id), status: quarantined.status },
            { status: 202, headers: { "Cache-Control": "no-store" } },
          );
        }

        const results = {}

        // 4️⃣ Upload the main file
        try {
          const uploadedFile = await retryWithBackoff(
            () => pinata.upload.public.file(file),
            3,
            1000,
            (err, attempt) => {
              console.warn(`[Storage] Document upload attempt ${attempt} failed: ${err.message}`);
            }
          )
          validatePinataResponse(uploadedFile, 'document')
          
          const fileUrl = await retryWithBackoff(
            () => pinata.gateways.public.convert(uploadedFile.cid),
            3,
            1000,
            (err, attempt) => {
              console.warn(`[Storage] Document gateway conversion attempt ${attempt} failed: ${err.message}`);
            }
          )
          validateGatewayUrl(fileUrl, 'document')
          results.fileUrl = fileUrl
          results.storageKey = uploadedFile.cid
        } catch (err) {
          auditLog({
            event: 'upload_failed',
            route: 'upload',
            method: 'POST',
            status: 500,
            reason: `document_upload_failure: ${err.message}`,
          })
          return NextResponse.json(
            { error: `Failed to upload document to storage: ${err.message}` },
            { status: 500 }
          )
        }

        // 5️⃣ Upload thumbnail (if provided)
        if (image) {
          try {
            const fileThumb = await retryWithBackoff(
              () => pinata.upload.public.file(image),
              3,
              1000,
              (err, attempt) => {
                console.warn(`[Storage] Thumbnail upload attempt ${attempt} failed: ${err.message}`);
              }
            )
            validatePinataResponse(fileThumb, 'thumbnail')

            const imgUrl = await retryWithBackoff(
              () => pinata.gateways.public.convert(fileThumb.cid),
              3,
              1000,
              (err, attempt) => {
                console.warn(`[Storage] Thumbnail gateway conversion attempt ${attempt} failed: ${err.message}`);
              }
            )
            validateGatewayUrl(imgUrl, 'thumbnail')
            results.imgUrl = imgUrl
          } catch (err) {
            auditLog({
              event: 'upload_failed',
              route: 'upload',
              method: 'POST',
              status: 500,
              reason: `thumbnail_upload_failure: ${err.message}`,
            })
            return NextResponse.json(
              { error: `Failed to upload thumbnail to storage: ${err.message}` },
              { status: 500 }
            )
          }
        }

        // 6️⃣ Prepare the rest of the form data as JSON
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

        // Include storage reference inside the metadata
        const metadataJSON = {
          name: sanitizedScalarFields.title || sanitizedScalarFields.name || "",
          description: sanitizedScalarFields.description || "",
          image: results.imgUrl || null,
          properties: {
            ...sanitizedScalarFields,
            coverImageUrl: results.imgUrl || sanitizedScalarFields.coverImageUrl || null,
            thumbnailUrl: results.imgUrl || sanitizedScalarFields.thumbnailUrl || null,
            learningOutcomes: normalizeStringList(previewInputs.learningOutcomes, {
              maxItems: 8,
              maxLength: 180,
            }),
            tableOfContents: normalizeStringList(previewInputs.tableOfContents, {
              maxItems: 16,
              maxLength: 180,
            }),
            sampleNotes: normalizeStringList(previewInputs.sampleNotes, {
              maxItems: 6,
              maxLength: 280,
            }),
            storageKey: uploadedFile.cid,
            fileUrl: results.fileUrl,
            timestamp: new Date().toISOString(),
          },
          ...sanitizedScalarFields,
          coverImageUrl: results.imgUrl || normalizeImageField(sanitizedScalarFields.coverImageUrl, "coverImageUrl"),
          thumbnailUrl: results.imgUrl || normalizeImageField(sanitizedScalarFields.thumbnailUrl, "thumbnailUrl"),
          learningOutcomes: normalizeStringList(previewInputs.learningOutcomes, {
            maxItems: 8,
            maxLength: 180,
          }),
          tableOfContents: normalizeStringList(previewInputs.tableOfContents, {
            maxItems: 16,
            maxLength: 180,
          }),
          sampleNotes: normalizeStringList(previewInputs.sampleNotes, {
            maxItems: 6,
            maxLength: 280,
          }),
          storageKey: results.storageKey,
          fileUrl: results.fileUrl,
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
        try {
          const uploadedJson = await retryWithBackoff(
            () => pinata.upload.public.json(metadataJSON),
            3,
            1000,
            (err, attempt) => {
              console.warn(`[Storage] Metadata upload attempt ${attempt} failed: ${err.message}`);
            }
          )
          validatePinataResponse(uploadedJson, 'metadata')

          const jsonUrl = await retryWithBackoff(
            () => pinata.gateways.public.convert(uploadedJson.cid),
            3,
            1000,
            (err, attempt) => {
              console.warn(`[Storage] Metadata gateway conversion attempt ${attempt} failed: ${err.message}`);
            }
          )
          validateGatewayUrl(jsonUrl, 'metadata')
          results.metadataUrl = jsonUrl
        } catch (err) {
          auditLog({
            event: 'upload_failed',
            route: 'upload',
            method: 'POST',
            status: 500,
            reason: `metadata_upload_failure: ${err.message}`,
          })
          return NextResponse.json(
            { error: `Failed to publish metadata to storage: ${err.message}` },
            { status: 500 }
          )
        }

        auditLog({
          event: 'upload_complete',
          route: 'upload',
          method: 'POST',
          status: 200,
        })

        // 8️⃣ Generate manifest for provenance tracking
        const fileHash = hashFileBytes(fileBuffer);
        let manifestDigest = null;
        try {
          const { digest } = await storeManifest({
            materialId: results.storageKey,
            version: 1,
            previousVersionDigest: null,
            creator: otherFields.userAddress || otherFields.creatorAddress || null,
            file: {
              cid: results.storageKey,
              hash: fileHash,
              size: file.size,
              type: file.type || "application/octet-stream",
            },
            preview: results.imgUrl ? {
              thumbnailCid: results.imgUrl,
            } : null,
            metadata: {
              title: metadataPayload.title,
              description: metadataPayload.description,
            },
            rights: metadataPayload.usageRights ? {
              usageRights: metadataPayload.usageRights,
            } : null,
          });
          manifestDigest = digest;
        } catch (manifestErr) {
          console.warn("[Upload] Manifest generation failed:", manifestErr?.message);
        }

        // 9️⃣ Return the CID as storageKey and also include URLs for backwards-compatibility
        return NextResponse.json({
          success: true,
          storageKey: results.storageKey,
          fileUrl: results.fileUrl,
          image: results.imgUrl || '',
          metadata: results.metadataUrl,
          manifestDigest,
          fileHash,
        })
      } catch (err) {
        auditLog({
          event: 'upload_failed',
          route: 'upload',
          method: 'POST',
          status: 500,
          reason: err.message,
        })

        // Fallback: save to MongoDB pending_pins
        try {
          const db = await getDb()
          const pendingCollection = db.collection('pending_pins')
          
          const form = await request.clone().formData().catch(() => null);
          if (!form) throw new Error("Could not clone form data");

          const file = form.get('file')
          const image = form.get('thumbnail')
          
          const fileBuffer = Buffer.from(await file.arrayBuffer())
          let imageBuffer = null
          if (image) {
            imageBuffer = Buffer.from(await image.arrayBuffer())
          }
          
          const otherFields = {}
          for (const [key, value] of form.entries()) {
            if (key !== 'file' && key !== 'thumbnail') {
              otherFields[key] = value
            }
          }

          await pendingCollection.insertOne({
            status: 'pending',
            createdAt: new Date(),
            fileData: fileBuffer,
            fileType: file?.type,
            fileName: file?.name,
            imageData: imageBuffer,
            imageType: image?.type,
            imageName: image?.name,
            otherFields: otherFields
          })

          return NextResponse.json(
            { success: true, status: 'pending', message: 'Upload queued due to network issues.' },
            { status: 202 }
          )
        } catch (dbErr) {
          return NextResponse.json(
            { error: err.message || 'Upload failed' },
            { status: 500 }
          )
        }
      }
    },
  )
}

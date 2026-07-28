export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/api/audit'
import { withApiHardening } from '@/lib/api/hardening'
import {
  normalizeStringList,
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

import { getDb } from '@/lib/mongodb';
import { createQuarantineRecord, QUARANTINE_STATES } from '@/lib/publishing/quarantine';
import { enqueueSideEffect } from '@/lib/backend/outbox';

export async function POST(request) {
  return withApiHardening(
    request,
    { route: 'materials/upload', rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      try {
        const form = await request.formData();
        const file = form.get('file');
        const image = form.get('thumbnail');
        const uploaderAddress = request.headers.get('x-wallet-address') || 'anonymous';

        // 1. Require a document file
        if (!file) {
          auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 400, reason: 'missing_file' });
          return NextResponse.json({ error: 'No document file provided.' }, { status: 400 });
        }

        // 2. Size check
        if (file.size > MAX_FILE_SIZE_BYTES) {
          const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
          auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 413, reason: 'file_too_large' });
          return NextResponse.json({ error: `File size (${sizeMB}MB) exceeds the 10MB limit.` }, { status: 413 });
        }

        // 3. MIME allowlist
        if (!ALLOWED_FILE_TYPES.includes(file.type)) {
          auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 415, reason: 'unsupported_file_type' });
          return NextResponse.json(
            { error: `Unsupported file type: ${file.type || 'unknown'}. Allowed types include PDF, Word, Excel, PPT, TXT, and ZIP.` },
            { status: 415 }
          );
        }

        // 4. Magic number validation
        const fileCheck = await validateUploadedFile(file, ALLOWED_FILE_TYPES);
        if (!fileCheck.valid) {
          auditLog({ event: 'upload_blocked', route: 'materials/upload', method: 'POST', status: 422, reason: fileCheck.reason });
          return NextResponse.json({ error: fileCheck.reason }, { status: 422 });
        }

        // 5. Thumbnail validation (same as before)
        if (image) {
          if (image.size > MAX_THUMBNAIL_SIZE_BYTES) {
            const sizeMB = (image.size / (1024 * 1024)).toFixed(2);
            auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 413, reason: 'thumbnail_too_large' });
            return NextResponse.json({ error: `Thumbnail size (${sizeMB}MB) exceeds the 5MB limit.` }, { status: 413 });
          }
          if (!ALLOWED_IMAGE_TYPES.includes(image.type)) {
            auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 415, reason: 'unsupported_thumbnail_type' });
            return NextResponse.json({ error: `Unsupported thumbnail type: ${image.type || 'unknown'}. Allowed types are JPG, PNG, and WEBP.` }, { status: 415 });
          }
          const imgCheck = await validateUploadedFile(image, ALLOWED_IMAGE_TYPES);
          if (!imgCheck.valid) {
            auditLog({ event: 'upload_blocked', route: 'materials/upload', method: 'POST', status: 422, reason: imgCheck.reason });
            return NextResponse.json({ error: imgCheck.reason }, { status: 422 });
          }
        }

        // 6. Structured metadata validation
        try {
          validateUploadFileMetadata(file, 'file');
        } catch (validationErr) {
          auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 400, reason: validationErr.message });
          return NextResponse.json({ error: validationErr.message }, { status: 400 });
        }

        const metadataPayload = {
          title: form.get('title') || form.get('name'),
          description: form.get('description'),
          price: form.get('price'),
          usageRights: form.get('usageRights'),
          visibility: form.get('visibility'),
        };

        try {
          validateUploadPayload(metadataPayload);
        } catch (validationErr) {
          auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 400, reason: validationErr.message });
          return NextResponse.json({ error: validationErr.message }, { status: 400 });
        }

        // 7. Stream upload into quarantine and create scan record
        const uploadedFile = await pinata.upload.public.file(file);
        const fileUrl = await pinata.gateways.public.convert(uploadedFile.cid);

        let imgUrl = null;
        if (image) {
          const fileThumb = await pinata.upload.public.file(image);
          imgUrl = await pinata.gateways.public.convert(fileThumb.cid);
        }

        const title = form.get('title') || form.get('name') || 'Untitled Material';

        const db = await getDb();
        const quarantine = await createQuarantineRecord({
          db,
          contentHash: uploadedFile.cid,
          fileName: title,
          mimeType: file.type,
          sizeBytes: file.size,
          uploaderAddress,
          materialId: null,
        });

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
        });

        auditLog({
          event: 'upload_quarantined',
          route: 'materials/upload',
          method: 'POST',
          status: 202,
          contentHash: quarantine.contentHash,
        });

        return NextResponse.json({
          success: true,
          status: 'quarantined',
          storageKey: uploadedFile.cid,
          contentHash: quarantine.contentHash,
          image: imgUrl || '',
          metadata: null,
        });
      } catch (err) {
        auditLog({ event: 'upload_failed', route: 'materials/upload', method: 'POST', status: 500, reason: err.message });
        return NextResponse.json({ error: err.message || 'Upload failed' }, { status: 500 });
      }
    }
  );
}

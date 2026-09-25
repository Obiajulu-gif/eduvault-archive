// Wires archiveExtractor.js (issue #639) into the upload path for zip
// uploads specifically. Kept separate from route.js so the route stays
// readable and this is independently unit-testable without mocking the
// whole Next.js request/FormData machinery.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ArchiveRejectedError, extractArchiveSafely } from './archiveExtractor';

const ZIP_MIME_TYPES = ['application/zip', 'application/x-zip-compressed'];

export function isZipUpload(file) {
  return ZIP_MIME_TYPES.includes(file?.type);
}

/**
 * Runs the uploaded zip through extractArchiveSafely before it's allowed to
 * proceed to storage. Writes the uploaded File/Blob to a temp file (the
 * extractor works on a real file path, not an in-memory buffer, since it
 * has to reopen it via yauzl's random-access central-directory reader).
 *
 * Returns { safe: true } when the archive is clean, or
 * { safe: false, reason, details } when rejected — this function never
 * throws for a rejected archive, only for a genuine I/O failure, so a
 * caller can turn a rejection into a normal 4xx response.
 */
export async function guardZipArchiveUpload(file, { quarantineRoot = os.tmpdir() } = {}) {
  if (!isZipUpload(file)) {
    return { safe: true };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-upload-guard-'));
  const tempZipPath = path.join(tempDir, `${randomUUID()}.zip`);

  try {
    const arrayBuffer = await file.arrayBuffer();
    await fs.writeFile(tempZipPath, Buffer.from(arrayBuffer));

    const result = await extractArchiveSafely(tempZipPath, path.join(quarantineRoot, 'archive-quarantine'));
    return { safe: true, entryCount: result.entryCount, expandedBytes: result.expandedBytes };
  } catch (err) {
    if (err instanceof ArchiveRejectedError) {
      return { safe: false, reason: err.reason, details: err.details };
    }
    throw err;
  } finally {
    // The temp copy of the uploaded zip itself is always cleaned up — only
    // a REJECTED extraction's partial output (under quarantineRoot) is
    // preserved as audit evidence; this is just the working copy used to
    // run the check.
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

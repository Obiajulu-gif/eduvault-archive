// Issue #639: safe extraction of untrusted zip archives.
//
// Current context: src/app/api/upload/route.js accepts `application/zip`
// uploads but pins the whole file to IPFS as an opaque blob — nothing in
// this repo extracts an archive server-side today. This module exists so
// that when archive extraction IS wired in (e.g. previewing archive
// contents, bulk material import), it goes through these guardrails rather
// than a naive yauzl/adm-zip loop.
//
// Threat model covered: zip-slip path traversal, symlink/device entries,
// nested archives (zip bombs via recursion), duplicate canonical paths from
// different raw byte sequences (Unicode normalization tricks), and
// decompression bombs (extreme compression ratios / entry counts / total
// expanded size) — all enforced DURING streaming, not after a full
// extraction, so a bomb can't exhaust memory/disk before being caught.

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import yauzl from 'yauzl';

export const ARCHIVE_LIMITS = {
  maxEntries: 2000,
  maxDepth: 12,
  maxExpandedBytes: 500 * 1024 * 1024, // 500MB total across all entries
  maxPerFileBytes: 100 * 1024 * 1024, // 100MB per entry
  // A ratio above this for a single entry is treated as a decompression
  // bomb signature (a legitimate document/media file rarely compresses
  // this well; 100:1 is already generous for text-heavy content).
  maxCompressionRatio: 100,
};

export class ArchiveRejectedError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = 'ArchiveRejectedError';
    this.reason = reason;
    this.details = details;
  }
}

// Symlink bit in the Unix mode stored in the top 16 bits of
// externalFileAttributes (standard zip/Info-ZIP convention).
const UNIX_MODE_SHIFT = 16;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFCHR = 0o020000; // character device
const S_IFBLK = 0o060000; // block device
const S_IFIFO = 0o010000; // named pipe/FIFO
const S_IFSOCK = 0o140000; // socket

function unixModeOf(entry) {
  return (entry.externalFileAttributes >>> UNIX_MODE_SHIFT) & 0xffff;
}

function isSymlinkOrDeviceEntry(entry) {
  const mode = unixModeOf(entry);
  const fileType = mode & S_IFMT;
  return (
    fileType === S_IFLNK ||
    fileType === S_IFCHR ||
    fileType === S_IFBLK ||
    fileType === S_IFIFO ||
    fileType === S_IFSOCK
  );
}

const ARCHIVE_EXTENSIONS = ['.zip', '.jar', '.war', '.ear', '.docx', '.xlsx', '.pptx'];

function looksLikeNestedArchive(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ARCHIVE_EXTENSIONS.includes(ext);
}

/**
 * Normalizes and validates one entry's path against `extractionRoot`.
 * Throws ArchiveRejectedError for traversal, absolute paths, or a resolved
 * path that escapes the root. Returns the safe absolute destination path.
 */
export function resolveSafeEntryPath(extractionRoot, rawEntryName) {
  if (rawEntryName.includes('\0')) {
    throw new ArchiveRejectedError('null_byte_in_path', { entry: rawEntryName });
  }

  // NFC-normalize so visually-identical names that differ only in Unicode
  // composition (e.g. combining accents vs. precomposed characters) collapse
  // to the same canonical string for duplicate-detection purposes.
  const normalized = rawEntryName.normalize('NFC');

  if (path.isAbsolute(normalized) || /^[a-zA-Z]:[\\/]/.test(normalized)) {
    throw new ArchiveRejectedError('absolute_path', { entry: rawEntryName });
  }

  const resolvedRoot = path.resolve(extractionRoot);
  const resolvedTarget = path.resolve(resolvedRoot, normalized);

  // The canonical zip-slip check: the resolved path must still be inside
  // the extraction root after resolving any `..` segments.
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ArchiveRejectedError('path_traversal', { entry: rawEntryName });
  }

  return { safePath: resolvedTarget, canonicalName: normalized };
}

/**
 * Extracts a zip archive into a fresh, isolated temp directory under
 * `quarantineRoot`, enforcing all ARCHIVE_LIMITS while streaming. On any
 * violation, the partial extraction directory is preserved (not deleted)
 * for audit evidence, and an ArchiveRejectedError is thrown with a `reason`
 * and enough `details` to reconstruct what tripped the limit.
 *
 * Returns { extractedTo, entryCount, expandedBytes } on success.
 */
export async function extractArchiveSafely(
  archivePath,
  quarantineRoot,
  { limits = ARCHIVE_LIMITS, extractionId = `extract-${Date.now()}-${Math.random().toString(36).slice(2)}` } = {},
) {
  const extractionRoot = path.join(quarantineRoot, extractionId);
  await fsp.mkdir(extractionRoot, { recursive: true });

  const seenCanonicalPaths = new Set();
  let entryCount = 0;
  let expandedBytes = 0;

  const zipfile = await new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, validateEntrySizes: true }, (err, zf) => {
      if (err) reject(new ArchiveRejectedError('malformed_archive', { message: err.message }));
      else resolve(zf);
    });
  });

  const fail = async (reason, details) => {
    zipfile.close();
    // Partial extraction is left in place under quarantineRoot for audit
    // evidence — the caller is responsible for eventual cleanup/retention
    // policy, this function never silently deletes evidence of a rejected
    // upload.
    throw new ArchiveRejectedError(reason, { ...details, extractedTo: extractionRoot });
  };

  return new Promise((resolve, reject) => {
    zipfile.readEntry();

    zipfile.on('entry', (entry) => {
      (async () => {
        entryCount += 1;
        if (entryCount > limits.maxEntries) {
          return fail('too_many_entries', { limit: limits.maxEntries, entryCount });
        }

        let safePath, canonicalName;
        try {
          ({ safePath, canonicalName } = resolveSafeEntryPath(extractionRoot, entry.fileName));
        } catch (err) {
          return fail(err.reason || 'invalid_entry_path', { entry: entry.fileName, ...err.details });
        }

        const depth = canonicalName.split('/').filter(Boolean).length;
        if (depth > limits.maxDepth) {
          return fail('max_depth_exceeded', { entry: canonicalName, depth, limit: limits.maxDepth });
        }

        if (seenCanonicalPaths.has(canonicalName)) {
          return fail('duplicate_canonical_path', { entry: canonicalName });
        }
        seenCanonicalPaths.add(canonicalName);

        if (isSymlinkOrDeviceEntry(entry)) {
          return fail('symlink_or_device_entry', { entry: canonicalName });
        }

        const isDirectory = entry.fileName.endsWith('/');
        if (isDirectory) {
          await fsp.mkdir(safePath, { recursive: true });
          zipfile.readEntry();
          return;
        }

        if (looksLikeNestedArchive(canonicalName)) {
          return fail('nested_archive_rejected', { entry: canonicalName });
        }

        if (entry.uncompressedSize > limits.maxPerFileBytes) {
          return fail('entry_too_large', {
            entry: canonicalName,
            size: entry.uncompressedSize,
            limit: limits.maxPerFileBytes,
          });
        }

        if (
          entry.compressedSize > 0 &&
          entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio
        ) {
          return fail('compression_ratio_exceeded', {
            entry: canonicalName,
            ratio: entry.uncompressedSize / entry.compressedSize,
            limit: limits.maxCompressionRatio,
          });
        }

        if (expandedBytes + entry.uncompressedSize > limits.maxExpandedBytes) {
          return fail('total_expanded_size_exceeded', {
            entry: canonicalName,
            wouldBe: expandedBytes + entry.uncompressedSize,
            limit: limits.maxExpandedBytes,
          });
        }

        await fsp.mkdir(path.dirname(safePath), { recursive: true });

        const readStream = await new Promise((res, rej) => {
          zipfile.openReadStream(entry, (err, stream) => (err ? rej(err) : res(stream)));
        });

        let bytesWrittenForEntry = 0;
        const writeStream = fs.createWriteStream(safePath);

        await new Promise((res, rej) => {
          readStream.on('data', (chunk) => {
            bytesWrittenForEntry += chunk.length;
            // Re-check per-entry and total limits mid-stream: a lying
            // central-directory size header (uncompressedSize claims small,
            // actual stream is huge) is caught here, not just up-front.
            if (bytesWrittenForEntry > limits.maxPerFileBytes) {
              readStream.destroy();
              writeStream.destroy();
              rej(
                new ArchiveRejectedError('entry_too_large_during_stream', {
                  entry: canonicalName,
                  limit: limits.maxPerFileBytes,
                }),
              );
              return;
            }
            if (expandedBytes + bytesWrittenForEntry > limits.maxExpandedBytes) {
              readStream.destroy();
              writeStream.destroy();
              rej(
                new ArchiveRejectedError('total_expanded_size_exceeded_during_stream', {
                  entry: canonicalName,
                  limit: limits.maxExpandedBytes,
                }),
              );
              return;
            }
          });
          readStream.on('error', rej);
          writeStream.on('error', rej);
          writeStream.on('finish', res);
          readStream.pipe(writeStream);
        }).catch(async (err) => {
          if (err instanceof ArchiveRejectedError) {
            return fail(err.reason, err.details);
          }
          return fail('stream_error', { entry: canonicalName, message: err.message });
        });

        expandedBytes += bytesWrittenForEntry;
        zipfile.readEntry();
      })().catch(reject);
    });

    zipfile.on('end', () => {
      resolve({ extractedTo: extractionRoot, entryCount, expandedBytes });
    });

    zipfile.on('error', (err) => {
      // yauzl does its own baseline filename validation (rejects a literal
      // ".." path segment, a backslash, or an absolute path) before ever
      // emitting an `entry` event for a bad name, surfacing it as a
      // zipfile-level error rather than routing through our own `entry`
      // handler above. Map that specific case to the same `path_traversal`/
      // `absolute_path` reasons our own resolveSafeEntryPath uses, so
      // callers see one consistent rejection taxonomy regardless of which
      // layer actually caught it.
      const message = err.message || '';
      // extractedTo is included here too (not just from the `fail()` path
      // above) so audit evidence for whatever entries were already written
      // before this rejection is reported consistently regardless of which
      // layer — our own resolveSafeEntryPath, or yauzl's own baseline
      // filename validation — actually caught the problem.
      const details = { message, extractedTo: extractionRoot };
      if (message.startsWith('invalid relative path:')) {
        reject(new ArchiveRejectedError('path_traversal', details));
      } else if (message.startsWith('absolute path:')) {
        reject(new ArchiveRejectedError('absolute_path', details));
      } else if (message.startsWith('invalid characters in fileName:')) {
        reject(new ArchiveRejectedError('invalid_entry_path', details));
      } else {
        reject(new ArchiveRejectedError('archive_read_error', details));
      }
    });
  });
}

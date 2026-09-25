import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import {
  ArchiveRejectedError,
  ARCHIVE_LIMITS,
  extractArchiveSafely,
  resolveSafeEntryPath,
} from './archiveExtractor';

let workDir;

beforeEach(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-extractor-test-'));
});

afterEach(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

/**
 * Builds a zip file at `zipPath` from a list of { name, content, mode }
 * entries using yazl, so tests can construct genuinely adversarial zips
 * (symlink mode bits, oversized/low-entropy content) that a well-behaved
 * zip library wouldn't normally let you produce.
 *
 * yazl itself validates and rejects `../`-style traversal names at write
 * time (it's a well-behaved library defending against the exact same zip-
 * slip attack this module guards against) — so a `rawName` entry writes a
 * same-byte-length ASCII placeholder instead, then patches every raw
 * occurrence of that placeholder in the finished zip buffer to the real
 * (malicious) name. This produces a genuinely well-formed zip whose entry
 * name is whatever raw bytes we want, exactly like a hand-crafted
 * malicious zip would, without hand-rolling the zip format ourselves.
 */
function buildZip(zipPath, entries) {
  const placeholders = entries.map((entry) =>
    entry.rawName ? 'P'.repeat(Buffer.byteLength(entry.rawName, 'utf8')) : null,
  );

  return new Promise((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    entries.forEach((entry, i) => {
      const buffer = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? '');
      zipfile.addBuffer(buffer, entry.rawName ? placeholders[i] : entry.name, { mode: entry.mode });
    });
    zipfile.end();

    const chunks = [];
    zipfile.outputStream.on('data', (chunk) => chunks.push(chunk));
    zipfile.outputStream.on('error', reject);
    zipfile.outputStream.on('end', async () => {
      let buffer = Buffer.concat(chunks);
      entries.forEach((entry, i) => {
        if (!entry.rawName) return;
        buffer = Buffer.from(
          buffer.toString('latin1').split(placeholders[i]).join(entry.rawName),
          'latin1',
        );
      });
      try {
        await fsp.writeFile(zipPath, buffer);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

const quarantineRoot = () => path.join(workDir, 'quarantine');

describe('resolveSafeEntryPath', () => {
  it('resolves a normal relative path inside the root', () => {
    const { safePath } = resolveSafeEntryPath('/root', 'docs/readme.txt');
    expect(safePath).toBe(path.resolve('/root', 'docs/readme.txt'));
  });

  it('rejects a zip-slip traversal path', () => {
    expect(() => resolveSafeEntryPath('/root', '../../etc/passwd')).toThrow(ArchiveRejectedError);
  });

  it('rejects an absolute path entry', () => {
    expect(() => resolveSafeEntryPath('/root', '/etc/passwd')).toThrow(ArchiveRejectedError);
  });

  it('rejects a Windows-style absolute path entry', () => {
    expect(() => resolveSafeEntryPath('/root', 'C:\\Windows\\System32\\evil.dll')).toThrow(
      ArchiveRejectedError,
    );
  });

  it('rejects a null byte in the entry name', () => {
    expect(() => resolveSafeEntryPath('/root', 'file\0.txt')).toThrow(ArchiveRejectedError);
  });

  it('normalizes Unicode composition so visually-identical names collapse', () => {
    // "é" as a precomposed character (U+00E9) vs. "e" + combining acute
    // accent (U+0065 U+0301) — same visual name, different raw bytes.
    const precomposed = resolveSafeEntryPath('/root', 'caf\u00e9.txt');
    const decomposed = resolveSafeEntryPath('/root', 'cafe\u0301.txt');
    expect(precomposed.canonicalName).toBe(decomposed.canonicalName);
  });
});

describe('extractArchiveSafely — zip-slip and unsafe entries', () => {
  it('rejects a zip containing a traversal path and preserves the partial extraction for audit', async () => {
    const zipPath = path.join(workDir, 'evil.zip');
    await buildZip(zipPath, [
      { name: 'safe.txt', content: 'hello' },
      { rawName: '../../../../etc/passwd', content: 'pwned' },
    ]);

    await expect(extractArchiveSafely(zipPath, quarantineRoot())).rejects.toMatchObject({
      reason: 'path_traversal',
    });

    // No file should have escaped to a location outside the quarantine root.
    const escaped = path.resolve(os.tmpdir(), '..', '..', 'etc', 'passwd');
    expect(fs.existsSync(escaped)).toBe(false);
  });

  it('rejects a symlink entry', async () => {
    const zipPath = path.join(workDir, 'symlink.zip');
    // Unix mode with the symlink file-type bits (0o120000) shifted into the
    // upper 16 bits of externalFileAttributes, as Info-ZIP tools do.
    await buildZip(zipPath, [{ name: 'link', content: '/etc/passwd', mode: 0o120777 }]);

    await expect(extractArchiveSafely(zipPath, quarantineRoot())).rejects.toMatchObject({
      reason: 'symlink_or_device_entry',
    });
  });

  it('rejects duplicate canonical paths from different raw byte sequences', async () => {
    const zipPath = path.join(workDir, 'dup.zip');
    await buildZip(zipPath, [
      { name: 'caf\u00e9.txt', content: 'first' },
      { name: 'cafe\u0301.txt', content: 'second' },
    ]);

    await expect(extractArchiveSafely(zipPath, quarantineRoot())).rejects.toMatchObject({
      reason: 'duplicate_canonical_path',
    });
  });

  it('rejects a nested archive rather than recursively extracting it', async () => {
    const innerZipPath = path.join(workDir, 'inner.zip');
    await buildZip(innerZipPath, [{ name: 'x.txt', content: 'x' }]);
    const innerZipBuffer = await fsp.readFile(innerZipPath);

    const outerZipPath = path.join(workDir, 'outer.zip');
    await buildZip(outerZipPath, [{ name: 'nested.zip', content: innerZipBuffer }]);

    await expect(extractArchiveSafely(outerZipPath, quarantineRoot())).rejects.toMatchObject({
      reason: 'nested_archive_rejected',
    });
  });

  it('rejects an entry nested deeper than maxDepth', async () => {
    const deepPath = Array.from({ length: 20 }, (_, i) => `dir${i}`).join('/') + '/file.txt';
    const zipPath = path.join(workDir, 'deep.zip');
    await buildZip(zipPath, [{ name: deepPath, content: 'x' }]);

    await expect(extractArchiveSafely(zipPath, quarantineRoot())).rejects.toMatchObject({
      reason: 'max_depth_exceeded',
    });
  });

  it('rejects an archive with more entries than maxEntries', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, content: 'x' }));
    const zipPath = path.join(workDir, 'many.zip');
    await buildZip(zipPath, entries);

    await expect(
      extractArchiveSafely(zipPath, quarantineRoot(), { limits: { ...ARCHIVE_LIMITS, maxEntries: 3 } }),
    ).rejects.toMatchObject({ reason: 'too_many_entries' });
  });
});

describe('extractArchiveSafely — decompression bombs', () => {
  it('rejects an entry whose compression ratio exceeds the configured limit', async () => {
    // 10MB of a single repeated byte compresses extremely well — a
    // realistic "zip bomb" signature, not an actual multi-gigabyte bomb
    // (keeping the test fast), but with the same ratio shape.
    const bombContent = Buffer.alloc(10 * 1024 * 1024, 0);
    const zipPath = path.join(workDir, 'bomb.zip');
    await buildZip(zipPath, [{ name: 'bomb.bin', content: bombContent }]);

    await expect(
      extractArchiveSafely(zipPath, quarantineRoot(), {
        limits: { ...ARCHIVE_LIMITS, maxCompressionRatio: 50, maxPerFileBytes: 50 * 1024 * 1024 },
      }),
    ).rejects.toMatchObject({ reason: 'compression_ratio_exceeded' });
  });

  it('rejects a single entry larger than maxPerFileBytes', async () => {
    const content = Buffer.alloc(2 * 1024 * 1024, 1); // low-compressibility-ish via non-zero fill
    const zipPath = path.join(workDir, 'large.zip');
    await buildZip(zipPath, [{ name: 'large.bin', content }]);

    await expect(
      extractArchiveSafely(zipPath, quarantineRoot(), {
        limits: { ...ARCHIVE_LIMITS, maxPerFileBytes: 1024 * 1024, maxCompressionRatio: 1_000_000 },
      }),
    ).rejects.toMatchObject({ reason: 'entry_too_large' });
  });

  it('rejects when total expanded size across multiple entries exceeds the limit', async () => {
    const content = Buffer.alloc(600 * 1024, 2);
    const zipPath = path.join(workDir, 'total.zip');
    await buildZip(zipPath, [
      { name: 'a.bin', content },
      { name: 'b.bin', content },
      { name: 'c.bin', content },
    ]);

    await expect(
      extractArchiveSafely(zipPath, quarantineRoot(), {
        limits: {
          ...ARCHIVE_LIMITS,
          maxExpandedBytes: 1024 * 1024, // 1MB total, but 3 * 600KB entries
          maxPerFileBytes: 700 * 1024,
          maxCompressionRatio: 1_000_000,
        },
      }),
    ).rejects.toMatchObject({ reason: 'total_expanded_size_exceeded' });
  });
});

describe('extractArchiveSafely — accepted archives', () => {
  it('extracts a well-formed archive with nested safe directories', async () => {
    const zipPath = path.join(workDir, 'good.zip');
    await buildZip(zipPath, [
      { name: 'readme.txt', content: 'hello world' },
      { name: 'docs/notes.txt', content: 'some notes' },
      { name: 'docs/images/logo.txt', content: 'not really an image, just text' },
    ]);

    const result = await extractArchiveSafely(zipPath, quarantineRoot());
    expect(result.entryCount).toBe(3);

    const readme = await fsp.readFile(path.join(result.extractedTo, 'readme.txt'), 'utf8');
    expect(readme).toBe('hello world');

    const notes = await fsp.readFile(path.join(result.extractedTo, 'docs/notes.txt'), 'utf8');
    expect(notes).toBe('some notes');
  });

  it('preserves the partial extraction directory on rejection for audit evidence', async () => {
    const zipPath = path.join(workDir, 'partial.zip');
    await buildZip(zipPath, [
      { name: 'ok-first.txt', content: 'this one is fine' },
      { rawName: '../escape.txt', content: 'this one is not' },
    ]);

    let caught;
    try {
      await extractArchiveSafely(zipPath, quarantineRoot());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ArchiveRejectedError);
    expect(fs.existsSync(caught.details.extractedTo)).toBe(true);
    // The first, safe entry should have actually been written before the
    // rejection — that's the audit evidence a reviewer needs.
    expect(fs.existsSync(path.join(caught.details.extractedTo, 'ok-first.txt'))).toBe(true);
  });
});

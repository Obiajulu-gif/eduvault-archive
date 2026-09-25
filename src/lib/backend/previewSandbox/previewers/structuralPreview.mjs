/**
 * Safe structural previewer for the preview sandbox (#638).
 *
 * Produces a small JSON *descriptor* of an attacker-controlled file without
 * rendering it and without inflating any compressed data. Dispatches on the
 * file's real leading bytes, never the declared MIME. The descriptor is built
 * field by field here, so no bytes, links, scripts, or metadata from the input
 * can ride along into the output.
 *
 * Built-ins only (no imports at all) — runs inside the forked, network-denied,
 * fs-read-scoped sandbox child.
 *
 * Complexity:
 *   - archive: O(E) in central-directory entry count E, hard-capped at
 *     `limits.maxEntries`; O(min(E, maxListedEntries)) descriptor space. Never
 *     O(uncompressed size) — entry payloads are never read.
 *   - document / text: O(min(size, cap)).
 */

const DEFAULTS = Object.freeze({
  maxEntries: 4096,
  maxListedEntries: 64,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  perEntryRatioLimit: 100,
  aggregateRatioLimit: 1000,
  maxNameLength: 512,
  textHeadBytes: 2048,
  scanHeadBytes: 4096,
});

export const PREVIEWER_VERSION = "structural-1";

// The complete, fixed set of descriptor flags. `previewValidation.js` pins to
// exactly this list.
export const FLAGS = Object.freeze([
  "encrypted",
  "macro",
  "executable-entry",
  "nested-archive",
  "path-traversal",
  "symlink-entry",
  "zip-bomb",
  "overlapping-entries",
  "zip64",
  "too-many-entries",
  "truncated-central-directory",
  "embedded-pdf",
  "embedded-archive",
  "embedded-script",
  "embedded-pe",
  "polyglot",
  "parse-error",
  "oversized",
]);

const EXECUTABLE_EXT = new Set([
  "exe", "dll", "scr", "bat", "cmd", "com", "ps1", "vbs", "vbe", "js", "jse",
  "jar", "msi", "hta", "wsf", "lnk", "app", "so", "dylib",
]);
const NESTED_ARCHIVE_EXT = new Set([
  "zip", "rar", "7z", "gz", "bz2", "xz", "tar", "tgz", "cab", "arj", "lzh", "iso",
]);

const SIG = {
  ZIP_LOCAL: 0x04034b50,
  ZIP_CDIR: 0x02014b50,
  ZIP_EOCD: 0x06054b50,
  ZIP64_EOCD: 0x06064b50,
};

/* ------------------------------- sniffing -------------------------------- */

function sniff(buf) {
  if (buf.length >= 4 && buf.readUInt32LE(0) === SIG.ZIP_LOCAL) return "zip";
  if (buf.length >= 4 && buf.readUInt32LE(0) === SIG.ZIP_EOCD) return "zip";
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  if (buf.length >= 8 && buf.toString("hex", 0, 8) === "d0cf11e0a1b11ae1") return "ole2";
  if (buf.length >= 8 && buf.toString("hex", 0, 8) === "89504e470d0a1a0a") return "png";
  if (buf.length >= 3 && buf.toString("hex", 0, 3) === "ffd8ff") return "jpeg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("latin1", 0, 6))) return "gif";
  if (buf.length >= 2 && buf.toString("latin1", 0, 2) === "MZ") return "pe";
  if (looksLikeText(buf)) return "text";
  return "unknown";
}

function looksLikeText(buf) {
  const n = Math.min(buf.length, 512);
  if (n === 0) return true;
  let nul = 0;
  for (let i = 0; i < n; i++) if (buf[i] === 0x00) nul++;
  return nul / n <= 0.01;
}

/* ------------------- embedded-signature / polyglot scan ----------------- */

function scanForEmbedded(buf, sniffed, flags, limits) {
  const headLen = Math.min(buf.length, limits.scanHeadBytes);
  const head = buf.toString("latin1", 0, headLen);
  const whole = buf.length <= 1 << 20 ? buf.toString("latin1") : head; // cap deep scan at 1 MiB

  // A %PDF marker anywhere other than offset 0 in a non-PDF file.
  const pdfAt = whole.indexOf("%PDF-");
  if (pdfAt > 0 && sniffed !== "pdf") flags.add("embedded-pdf");

  // A ZIP end-of-central-directory in a file that does not present as a zip.
  if (sniffed !== "zip") {
    const eocd = buf.length >= 22 && buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd && eocd > 0) flags.add("embedded-archive");
  }

  // A Windows PE payload embedded in a non-PE file: the unmistakable DOS-stub
  // string is a low-false-positive tell.
  if (sniffed !== "pe" && whole.includes("This program cannot be run in DOS mode")) {
    flags.add("embedded-pe");
  }

  if (/<script[\s>]/i.test(head) || /<\?php/i.test(head) || head.startsWith("#!")) {
    if (sniffed !== "text") flags.add("embedded-script");
  }

  if (flags.has("embedded-pdf") || flags.has("embedded-archive") || flags.has("embedded-pe") || flags.has("embedded-script")) {
    flags.add("polyglot");
    return true;
  }
  return false;
}

/* ------------------------------ sanitizers --------------------------- */

// Neutralise control chars (keep \t \n \r), BOM / zero-width (U+200B–U+200F,
// U+FEFF), bidi embeddings & isolates (U+202A–U+202E, U+2066–U+2069), and defang
// the two sequences an over-eager renderer might act on.
function sanitizeText(s) {
  return s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "\uFFFD")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/<\s*script/gi, "<\uFFFDscript")
    .replace(/javascript:/gi, "javascript\uFFFD:");
}

/* ------------------------------ name safety ---------------------------- */

function classifyName(rawName, flags) {
  // Decode as UTF-8; replace anything unrepresentable.
  let name = rawName.toString("utf8");
  let unsafe = false;

  if (/\x00/.test(name) || /[\x01-\x1f]/.test(name)) unsafe = true;
  if (name.includes("\\")) unsafe = true;
  if (name.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(name)) unsafe = true;
  if (name.split("/").some((seg) => seg === "..")) unsafe = true;

  if (unsafe) flags.add("path-traversal");

  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (EXECUTABLE_EXT.has(ext)) flags.add("executable-entry");
  if (NESTED_ARCHIVE_EXT.has(ext)) flags.add("nested-archive");
  if (name === "vbaProject.bin" || name.endsWith("/vbaProject.bin")) flags.add("macro");

  const sanitized = name
    .replace(/[\x00-\x1f]/g, "\uFFFD")
    .replace(/\\/g, "\uFFFD")
    .slice(0, DEFAULTS.maxNameLength);

  return { name: sanitized, unsafe, ext };
}

/* ----------------------------- zip parsing ---------------------------- */

function findEocd(buf) {
  // EOCD is 22 bytes + up to 65535 bytes of comment, at the tail.
  const minPos = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === SIG.ZIP_EOCD) return i;
  }
  return -1;
}

function parseArchive(buf, declaredType, sniffed, limits, flags) {
  const descriptor = {
    kind: "archive",
    declaredType,
    sniffedType: sniffed,
    bytes: buf.length,
    entryCount: 0,
    totalDeclaredUncompressedBytes: 0,
    maxCompressionRatio: 0,
    entries: [],
    polyglot: false,
    flags: [],
  };

  const eocdPos = findEocd(buf);
  if (eocdPos < 0) {
    flags.add("truncated-central-directory");
    flags.add("parse-error");
    return finalize(descriptor, flags);
  }

  const totalEntriesDeclared = buf.readUInt16LE(eocdPos + 10);
  let cdOffset = buf.readUInt32LE(eocdPos + 16);
  const cdSize = buf.readUInt32LE(eocdPos + 12);

  if (totalEntriesDeclared === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    flags.add("zip64");
  }

  if (cdOffset >= buf.length) {
    // Common in polyglots where a payload is prepended: retry from a scan.
    const scan = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    if (scan < 0) {
      flags.add("truncated-central-directory");
      flags.add("parse-error");
      return finalize(descriptor, flags);
    }
    cdOffset = scan;
  }

  const seenLocalOffsets = new Set();
  let pos = cdOffset;
  let count = 0;
  let aggUncompressed = 0;
  let aggCompressed = 0;

  while (pos + 46 <= buf.length && buf.readUInt32LE(pos) === SIG.ZIP_CDIR) {
    if (count >= limits.maxEntries) {
      flags.add("too-many-entries");
      break;
    }

    const bitFlag = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const externalAttr = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);

    const nameStart = pos + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > buf.length) {
      flags.add("truncated-central-directory");
      break;
    }

    if (bitFlag & 0x0001) flags.add("encrypted");
    if (((externalAttr >>> 16) & 0xf000) === 0xa000) flags.add("symlink-entry");
    if (seenLocalOffsets.has(localOffset)) {
      flags.add("overlapping-entries");
    } else {
      seenLocalOffsets.add(localOffset);
    }

    const { name } = classifyName(buf.subarray(nameStart, nameEnd), flags);

    const ratio = compressedSize > 0 ? uncompressedSize / compressedSize : uncompressedSize > 0 ? Infinity : 0;
    if (ratio > limits.perEntryRatioLimit) flags.add("zip-bomb");

    aggUncompressed += uncompressedSize;
    aggCompressed += compressedSize;
    descriptor.maxCompressionRatio = Math.max(descriptor.maxCompressionRatio, Number.isFinite(ratio) ? ratio : limits.aggregateRatioLimit + 1);

    if (descriptor.entries.length < limits.maxListedEntries) {
      descriptor.entries.push({
        name,
        size: uncompressedSize,
        compressedSize,
        ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : -1,
        method,
      });
    }

    count += 1;
    pos = nameEnd + extraLen + commentLen;
  }

  descriptor.entryCount = count;
  descriptor.totalDeclaredUncompressedBytes = aggUncompressed;

  const aggRatio = aggCompressed > 0 ? aggUncompressed / aggCompressed : 0;
  if (aggRatio > limits.aggregateRatioLimit) flags.add("zip-bomb");
  if (aggUncompressed > limits.maxTotalUncompressedBytes) {
    flags.add("zip-bomb");
    flags.add("oversized");
  }
  if (count < totalEntriesDeclared) flags.add("truncated-central-directory");
  if (flags.has("overlapping-entries")) flags.add("zip-bomb");

  return finalize(descriptor, flags);
}

/* --------------------------- document / text ------------------------- */

function parseDocument(buf, declaredType, sniffed, limits, flags) {
  const descriptor = {
    kind: "document",
    declaredType,
    sniffedType: sniffed,
    bytes: buf.length,
    polyglot: false,
    flags: [],
  };

  if (sniffed === "pdf") {
    const head = buf.toString("latin1", 0, Math.min(buf.length, 1024));
    const m = /%PDF-(\d\.\d)/.exec(head);
    descriptor.pdfVersion = m ? m[1] : null;
    descriptor.headerAtOffsetZero = head.startsWith("%PDF-");
    if (!descriptor.headerAtOffsetZero) flags.add("polyglot");
  } else {
    descriptor.pdfVersion = null;
    descriptor.headerAtOffsetZero = null;
  }

  return finalize(descriptor, flags);
}

function parseText(buf, declaredType, sniffed, limits, flags) {
  const slice = buf.subarray(0, limits.textHeadBytes);
  return finalize(
    {
      kind: "text",
      declaredType,
      sniffedType: sniffed,
      bytes: buf.length,
      textHead: sanitizeText(slice.toString("utf8")),
      truncated: buf.length > limits.textHeadBytes,
      polyglot: false,
      flags: [],
    },
    flags,
  );
}

/* ------------------------------- finalize ---------------------------- */

function finalize(descriptor, flagSet) {
  descriptor.flags = FLAGS.filter((f) => flagSet.has(f));
  if (flagSet.has("polyglot")) descriptor.polyglot = true;
  return descriptor;
}

/* -------------------------------- entry ----------------------------- */

/**
 * @param {{ input: Buffer, mimeType?: string, limits?: object }} args
 * @returns {object} the descriptor (always — parse failures are reported as
 *   `flags: ["parse-error"]`, never thrown, so the caller stays fail-closed).
 */
export function generatePreview({ input, mimeType = "", limits = {} }) {
  const L = { ...DEFAULTS, ...limits };
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);

  try {
    const sniffed = sniff(buf);

    // Embedded-signature / polyglot scan runs for every input, up front.
    const flags = new Set();
    scanForEmbedded(buf, sniffed, flags, L);

    if (sniffed === "zip") return parseArchive(buf, mimeType, sniffed, L, flags);
    if (sniffed === "pdf" || sniffed === "ole2") return parseDocument(buf, mimeType, sniffed, L, flags);
    if (sniffed === "text") return parseText(buf, mimeType, sniffed, L, flags);

    // Images / unknown: structure + the polyglot scan only.
    return finalize(
      { kind: sniffed === "unknown" ? "unknown" : "document", declaredType: mimeType, sniffedType: sniffed, bytes: buf.length, polyglot: false, flags: [] },
      flags,
    );
  } catch (err) {
    return {
      kind: "unknown",
      declaredType: mimeType,
      sniffedType: "unknown",
      bytes: buf.length,
      polyglot: false,
      flags: ["parse-error"],
      error: String(err?.message || err).slice(0, 200),
    };
  }
}

export default generatePreview;

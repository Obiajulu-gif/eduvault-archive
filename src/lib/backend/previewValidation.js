/**
 * Independent validation of a preview descriptor (#638).
 *
 * Runs in the trusted parent — never in the sandbox — and re-checks the
 * descriptor the sandbox produced before it may be stored or served. A
 * descriptor that fails here is discarded (state `rejected`), so a previewer
 * bug or a sandbox escape cannot get attacker-influenced content onto a
 * published surface.
 *
 * Time/space: O(S) in the serialized descriptor size S, which the sandbox
 * already caps.
 */

import { FLAGS } from "./previewSandbox/previewers/structuralPreview.mjs";

const ALLOWED_KINDS = new Set(["archive", "document", "text", "unknown"]);
const ALLOWED_SNIFFED = new Set(["zip", "pdf", "ole2", "png", "jpeg", "gif", "pe", "text", "unknown"]);
const FLAG_SET = new Set(FLAGS);

const MAX_SERIALIZED_BYTES = 64 * 1024;
const MAX_ENTRIES_LISTED = 128;
const MAX_STRING = 1024;
const MAX_TEXT_HEAD = 8 * 1024;

// Text-level injection sequences that must never survive into a stored
// descriptor string. Embedded *binary* signatures (PK\x03\x04, MZ, ...) are
// already caught by CONTROL_RE — a real one carries control bytes.
const FORBIDDEN_SUBSTRINGS = ["<script", "</script", "javascript:", "vbscript:", "data:text/html", "%pdf-", "<?php"];

// C0 controls except \t \n \r; zero-width / BOM (U+200B-U+200F, U+FEFF); bidi
// embeddings & isolates (U+202A-U+202E, U+2066-U+2069).
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

function fail(reason) {
  return { ok: false, reason };
}

function scanString(value, path, maxLen) {
  if (typeof value !== "string") return fail(`${path} must be a string`);
  if (value.length > maxLen) return fail(`${path} exceeds ${maxLen} chars`);
  if (CONTROL_RE.test(value)) return fail(`${path} contains control/bidi characters`);
  const lower = value.toLowerCase();
  for (const bad of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(bad)) return fail(`${path} contains a forbidden sequence`);
  }
  return { ok: true };
}

function isSafeInt(n, max = Number.MAX_SAFE_INTEGER) {
  return typeof n === "number" && Number.isFinite(n) && n >= -1 && n <= max;
}

/**
 * @param {unknown} descriptor  The `preview` object returned by the sandbox.
 * @param {{ mimeType?: string }} [context]
 * @returns {{ ok: true, descriptor: object, contentType: string } | { ok: false, reason: string }}
 */
export function validatePreviewOutput(descriptor, { mimeType = "" } = {}) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    return fail("descriptor must be a plain object");
  }

  let serialized;
  try {
    serialized = JSON.stringify(descriptor);
  } catch {
    return fail("descriptor is not JSON-serializable");
  }
  if (Buffer.byteLength(serialized) > MAX_SERIALIZED_BYTES) {
    return fail(`descriptor exceeds ${MAX_SERIALIZED_BYTES} bytes`);
  }

  if (!ALLOWED_KINDS.has(descriptor.kind)) return fail(`invalid kind: ${descriptor.kind}`);
  if (!ALLOWED_SNIFFED.has(descriptor.sniffedType)) return fail(`invalid sniffedType: ${descriptor.sniffedType}`);
  if (typeof descriptor.polyglot !== "boolean") return fail("polyglot must be a boolean");
  if (!isSafeInt(descriptor.bytes, 64 * 1024 * 1024) || descriptor.bytes < 0) return fail("invalid bytes");

  const dt = scanString(descriptor.declaredType ?? "", "declaredType", 256);
  if (!dt.ok) return dt;

  if (!Array.isArray(descriptor.flags)) return fail("flags must be an array");
  if (descriptor.flags.length > FLAGS.length) return fail("too many flags");
  for (const f of descriptor.flags) {
    if (!FLAG_SET.has(f)) return fail(`unknown flag: ${f}`);
  }

  if (descriptor.kind === "archive") {
    if (!isSafeInt(descriptor.entryCount, 1_000_000) || descriptor.entryCount < 0) return fail("invalid entryCount");
    if (!isSafeInt(descriptor.totalDeclaredUncompressedBytes) || descriptor.totalDeclaredUncompressedBytes < 0) {
      return fail("invalid totalDeclaredUncompressedBytes");
    }
    if (!isSafeInt(descriptor.maxCompressionRatio)) return fail("invalid maxCompressionRatio");
    if (!Array.isArray(descriptor.entries)) return fail("entries must be an array");
    if (descriptor.entries.length > MAX_ENTRIES_LISTED) return fail("too many listed entries");
    for (let i = 0; i < descriptor.entries.length; i++) {
      const e = descriptor.entries[i];
      if (!e || typeof e !== "object") return fail(`entries[${i}] invalid`);
      const n = scanString(e.name ?? "", `entries[${i}].name`, MAX_STRING);
      if (!n.ok) return n;
      if (!isSafeInt(e.size) || !isSafeInt(e.compressedSize) || !isSafeInt(e.ratio)) {
        return fail(`entries[${i}] numeric fields invalid`);
      }
      if (!isSafeInt(e.method, 0xffff) || e.method < 0) return fail(`entries[${i}].method invalid`);
    }
  }

  if (descriptor.kind === "document") {
    if (descriptor.pdfVersion != null && !/^\d\.\d$/.test(String(descriptor.pdfVersion))) return fail("invalid pdfVersion");
    if (descriptor.headerAtOffsetZero != null && typeof descriptor.headerAtOffsetZero !== "boolean") {
      return fail("invalid headerAtOffsetZero");
    }
  }

  if (descriptor.kind === "text") {
    const th = scanString(descriptor.textHead ?? "", "textHead", MAX_TEXT_HEAD);
    if (!th.ok) return th;
    if (typeof descriptor.truncated !== "boolean") return fail("truncated must be a boolean");
  }

  const allowed = new Set([
    "kind", "declaredType", "sniffedType", "bytes", "polyglot", "flags",
    "entryCount", "totalDeclaredUncompressedBytes", "maxCompressionRatio", "entries",
    "pdfVersion", "headerAtOffsetZero", "textHead", "truncated", "error",
  ]);
  for (const key of Object.keys(descriptor)) {
    if (!allowed.has(key)) return fail(`unexpected key: ${key}`);
  }
  if (descriptor.error != null) {
    const er = scanString(String(descriptor.error), "error", 256);
    if (!er.ok) return er;
  }

  return { ok: true, descriptor, contentType: "application/json" };
}

import crypto from 'node:crypto';
import { hashBytes } from '../backend/contentManifest.js';

export const SCAN_PROVENANCE_COLLECTION = 'scan_provenance';
export const SCAN_PROVENANCE_VERSION = '2026.11.1';
export const SCAN_PROVENANCE_ALGORITHM = 'sha256';

export const SCAN_PROVENANCE_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  UNAUTHORIZED_ACTOR: 'UNAUTHORIZED_ACTOR',
  BYTE_HASH_MISMATCH: 'BYTE_HASH_MISMATCH',
  CID_MISMATCH: 'CID_MISMATCH',
  SIZE_MISMATCH: 'SIZE_MISMATCH',
  SCANNER_MISMATCH: 'SCANNER_MISMATCH',
  PROVENANCE_MISMATCH: 'PROVENANCE_MISMATCH',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
});

const HEX_64 = /^[0-9a-f]{64}$/;
const MAX_TEXT_LENGTH = 1024;
const AUTHORIZED_ROLES = new Set(['system', 'service', 'admin']);

export class ScanProvenanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ScanProvenanceError';
    this.code = code;
    this.details = details;
  }
}

function normalizeBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new ScanProvenanceError(
    SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT,
    'bytes must be a Buffer, typed array, ArrayBuffer, or string'
  );
}

export function computeSha256(bytes) {
  return hashBytes(normalizeBytes(bytes));
}

function canonicalize(value) {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function digest(value) {
  return crypto
    .createHash(SCAN_PROVENANCE_ALGORITHM)
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT_LENGTH) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT,
      `${field} must be a non-empty string up to ${MAX_TEXT_LENGTH} characters`
    );
  }
  return value.trim();
}

function requireVersion(value, field) {
  if (value === null || value === undefined || value === '') {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT,
      `${field} is required`
    );
  }
  return requireText(String(value), field);
}

function normalizeSize(value, field) {
  const size = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(size) || size < 0) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT,
      `${field} must be a non-negative integer`
    );
  }
  return size;
}

function toIsoTimestamp(value) {
  const date = value === null || value === undefined
    ? new Date()
    : value instanceof Date
      ? value
      : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT,
      'timestamp must be a valid date'
    );
  }
  return date.toISOString();
}

function resolveScannerName({ scanner, scannerName, scanResult }) {
  const raw = scannerName
    ?? (typeof scanner === 'string' ? scanner : null)
    ?? scanner?.name
    ?? scanner?.scannerName
    ?? scanResult?.scannerName
    ?? scanResult?.scanner?.name;
  return requireText(raw === null || raw === undefined ? '' : String(raw), 'scanner');
}

function resolveSignatureVersion({ scanner, signatureVersion, scanResult }) {
  const raw = signatureVersion
    ?? scanResult?.signatureVersion
    ?? (scanner && typeof scanner === 'object' ? scanner.signatureVersion : null);
  return requireVersion(raw, 'signatureVersion');
}

function normalizeThreats(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT,
      'threats must be an array'
    );
  }
  return value.map((threat) => requireText(String(threat), 'threat'));
}

export function assertScanProvenanceActor(actor, { allowSystem = true } = {}) {
  let id = null;
  let role = null;

  if (typeof actor === 'string') {
    const text = actor.trim();
    id = text;
    if (/^(system|worker)$/i.test(text)) role = 'system';
    else if (/^service(:|$)/i.test(text)) role = 'service';
    else if (/^admin(:|$)/i.test(text)) role = 'admin';
  } else if (actor && typeof actor === 'object') {
    id = actor.id ?? actor.sub ?? actor.actorId ?? actor.principal ?? null;
    const roles = Array.isArray(actor.roles) ? actor.roles : [actor.role];
    role = roles
      .map((candidate) => (typeof candidate === 'string' ? candidate.trim().toLowerCase() : ''))
      .find((candidate) => AUTHORIZED_ROLES.has(candidate) || candidate === 'worker') ?? null;
    if (role === 'worker') role = 'system';
    if (!role && typeof id === 'string' && /^service(:|$)/i.test(id)) role = 'service';
  }

  if (!id || !role || (role === 'system' && !allowSystem)) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.UNAUTHORIZED_ACTOR,
      'Scan provenance requires a system, service, or admin actor'
    );
  }

  return { id: String(id), role };
}

export function buildScanProvenance(params = {}) {
  if (!params || typeof params !== 'object') {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT,
      'provenance parameters are required'
    );
  }

  const bytes = normalizeBytes(params.bytes ?? params.contentBytes);
  const computedByteHash = computeSha256(bytes);
  const providedByteHash = params.byteHash ?? params.expectedByteHash ?? computedByteHash;
  const byteHash = requireText(String(providedByteHash).toLowerCase(), 'byteHash');
  if (!HEX_64.test(byteHash)) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT,
      'byteHash must be a sha256 hex digest'
    );
  }
  if (computedByteHash !== byteHash) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.BYTE_HASH_MISMATCH,
      'Supplied bytes do not match the expected byteHash'
    );
  }

  const contentHash = requireText(
    String(params.contentHash ?? params.cid ?? params.expectedContentHash ?? ''),
    'contentHash'
  );
  if (params.cid !== undefined && String(params.cid) !== contentHash) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.CID_MISMATCH,
      'cid does not match contentHash'
    );
  }
  if (
    params.expectedContentHash !== undefined
    && String(params.expectedContentHash) !== contentHash
  ) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.CID_MISMATCH,
      'contentHash does not match the expected CID'
    );
  }

  const scanResult = params.scanResult || null;
  const artifactHash = params.artifactHash ?? scanResult?.artifactHash;
  if (artifactHash !== undefined && artifactHash !== null && String(artifactHash) !== contentHash) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.CID_MISMATCH,
      'scanner artifactHash does not match contentHash'
    );
  }

  const sizeBytes = normalizeSize(params.sizeBytes ?? bytes.length, 'sizeBytes');
  if (sizeBytes !== bytes.length) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.SIZE_MISMATCH,
      'sizeBytes does not match the supplied bytes'
    );
  }

  const scannerName = resolveScannerName({
    scanner: params.scanner,
    scannerName: params.scannerName,
    scanResult,
  });
  const signatureVersion = resolveSignatureVersion({
    scanner: params.scanner,
    signatureVersion: params.signatureVersion,
    scanResult,
  });
  const verdict = params.verdict ?? scanResult?.verdict ?? null;
  const threats = normalizeThreats(params.threats ?? scanResult?.threats);
  const scannedAt = toIsoTimestamp(params.scannedAt);

  const evidenceId = digest({
    version: SCAN_PROVENANCE_VERSION,
    algorithm: SCAN_PROVENANCE_ALGORITHM,
    byteHash,
    contentHash,
    sizeBytes,
    scannerName,
    signatureVersion,
    verdict,
    threats,
  });

  return {
    version: SCAN_PROVENANCE_VERSION,
    algorithm: SCAN_PROVENANCE_ALGORITHM,
    evidenceId,
    idempotencyKey: `scan-provenance:${SCAN_PROVENANCE_VERSION}:${evidenceId}`,
    byteHash,
    contentHash,
    cid: contentHash,
    sizeBytes,
    scanner: scannerName,
    scannerName,
    signatureVersion,
    engineVersion: params.engineVersion ?? scanResult?.engineVersion ?? null,
    verdict,
    threats,
    mediaType: params.mimeType ?? params.mediaType ?? null,
    materialId: params.materialId ?? null,
    uploaderAddress: params.uploaderAddress ?? null,
    scannedAt,
  };
}

export function verifyScanProvenance(provenanceOrParams, options = {}) {
  const params = provenanceOrParams && provenanceOrParams.provenance
    ? { ...provenanceOrParams, ...options }
    : { ...options, provenance: provenanceOrParams };
  const provenance = params.provenance;
  if (!provenance || typeof provenance !== 'object') {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT,
      'provenance is required'
    );
  }

  const bytes = normalizeBytes(params.bytes ?? params.contentBytes);
  const computedByteHash = computeSha256(bytes);
  const expectedByteHash = requireText(
    String(params.byteHash ?? params.expectedByteHash ?? provenance.byteHash ?? '').toLowerCase(),
    'byteHash'
  );
  if (computedByteHash !== expectedByteHash) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.BYTE_HASH_MISMATCH,
      'Supplied bytes do not match the expected byteHash'
    );
  }
  if (String(provenance.byteHash ?? '').toLowerCase() !== computedByteHash) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.BYTE_HASH_MISMATCH,
      'Recorded byteHash does not match the supplied bytes'
    );
  }

  const expectedContentHash = requireText(
    String(
      params.contentHash
      ?? params.expectedContentHash
      ?? provenance.contentHash
      ?? provenance.cid
      ?? ''
    ),
    'contentHash'
  );
  const recordedContentHash = String(provenance.contentHash ?? provenance.cid ?? '');
  if (expectedContentHash !== recordedContentHash) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.CID_MISMATCH,
      'contentHash does not match the recorded CID'
    );
  }

  const expectedSize = normalizeSize(params.sizeBytes ?? provenance.sizeBytes, 'sizeBytes');
  if (expectedSize !== bytes.length || normalizeSize(provenance.sizeBytes, 'sizeBytes') !== bytes.length) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.SIZE_MISMATCH,
      'sizeBytes does not match the supplied bytes or recorded provenance'
    );
  }

  const scannerName = resolveScannerName({
    scanner: params.scanner ?? provenance.scanner,
    scannerName: params.scannerName ?? provenance.scannerName,
    scanResult: params.scanResult,
  });
  const recordedScanner = resolveScannerName({
    scanner: provenance.scanner,
    scannerName: provenance.scannerName,
    scanResult: provenance.scanResult,
  });
  if (scannerName !== recordedScanner) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.SCANNER_MISMATCH,
      'scanner identity does not match the recorded provenance'
    );
  }

  const signatureVersion = resolveSignatureVersion({
    scanner: params.scanner ?? provenance.scanner,
    signatureVersion: params.signatureVersion ?? provenance.signatureVersion,
    scanResult: params.scanResult,
  });
  if (signatureVersion !== provenance.signatureVersion) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.PROVENANCE_MISMATCH,
      'signatureVersion does not match the recorded provenance'
    );
  }

  const rebuilt = buildScanProvenance({
    version: provenance.version,
    byteHash: computedByteHash,
    contentHash: expectedContentHash,
    sizeBytes: expectedSize,
    scanner: recordedScanner,
    signatureVersion,
    verdict: params.verdict ?? provenance.verdict,
    threats: params.threats ?? provenance.threats,
    engineVersion: params.engineVersion ?? provenance.engineVersion,
    mimeType: params.mimeType ?? provenance.mediaType,
    materialId: params.materialId ?? provenance.materialId,
    uploaderAddress: params.uploaderAddress ?? provenance.uploaderAddress,
    scannedAt: provenance.scannedAt,
    bytes,
  });

  if (
    rebuilt.evidenceId !== provenance.evidenceId
    || rebuilt.idempotencyKey !== provenance.idempotencyKey
  ) {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      'Provenance evidence ID does not match its bound content'
    );
  }

  return true;
}

export async function recordScanProvenance(params = {}) {
  if (!params || typeof params !== 'object' || !params.db || typeof params.db.collection !== 'function') {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT,
      'db is required'
    );
  }

  const principal = assertScanProvenanceActor(params.actor, {
    allowSystem: params.allowSystem !== false,
  });
  const provenance = buildScanProvenance(params);
  verifyScanProvenance({
    provenance,
    bytes: params.bytes ?? params.contentBytes,
    byteHash: provenance.byteHash,
    contentHash: provenance.contentHash,
    sizeBytes: provenance.sizeBytes,
    scanner: provenance.scanner,
    signatureVersion: provenance.signatureVersion,
    scanResult: params.scanResult,
    threats: provenance.threats,
    verdict: provenance.verdict,
    engineVersion: provenance.engineVersion,
    mimeType: provenance.mediaType,
    materialId: provenance.materialId,
    uploaderAddress: provenance.uploaderAddress,
  });

  const collection = params.db.collection(SCAN_PROVENANCE_COLLECTION);
  if (!collection || typeof collection.findOne !== 'function') {
    throw new ScanProvenanceError(
      SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT,
      'scan provenance collection is unavailable'
    );
  }
  if (typeof collection.createIndex === 'function') {
    await collection.createIndex({ idempotencyKey: 1 }, { unique: true, background: true });
    await collection.createIndex({ evidenceId: 1 }, { unique: true, background: true });
  }

  const existing = await collection.findOne({ idempotencyKey: provenance.idempotencyKey });
  if (existing) {
    verifyScanProvenance({
      provenance: existing.provenance ?? existing,
      bytes: params.bytes ?? params.contentBytes,
      byteHash: provenance.byteHash,
      contentHash: provenance.contentHash,
      sizeBytes: provenance.sizeBytes,
      scanner: provenance.scanner,
      signatureVersion: provenance.signatureVersion,
    });
    return {
      outcome: 'replayed',
      applied: false,
      record: existing,
      provenance: existing.provenance ?? existing,
    };
  }

  const record = {
    _id: provenance.evidenceId,
    evidenceId: provenance.evidenceId,
    idempotencyKey: provenance.idempotencyKey,
    version: provenance.version,
    algorithm: provenance.algorithm,
    byteHash: provenance.byteHash,
    contentHash: provenance.contentHash,
    cid: provenance.cid,
    sizeBytes: provenance.sizeBytes,
    scanner: provenance.scanner,
    scannerName: provenance.scannerName,
    signatureVersion: provenance.signatureVersion,
    engineVersion: provenance.engineVersion,
    verdict: provenance.verdict,
    threats: provenance.threats,
    mediaType: provenance.mediaType,
    materialId: provenance.materialId,
    uploaderAddress: provenance.uploaderAddress,
    scannedAt: provenance.scannedAt,
    actor: principal,
    recordedAt: toIsoTimestamp(params.now),
    scanResult: params.scanResult ?? null,
    provenance,
  };

  try {
    await collection.insertOne(record);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const raced = await collection.findOne({ idempotencyKey: provenance.idempotencyKey });
    if (!raced) throw error;
    return {
      outcome: 'replayed',
      applied: false,
      record: raced,
      provenance: raced.provenance ?? raced,
    };
  }

  return {
    outcome: 'recorded',
    applied: true,
    record,
    provenance,
  };
}

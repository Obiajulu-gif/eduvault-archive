import { createHash } from "node:crypto";

export const IMPORT_PROVENANCE_CHAIN_VERSION = 1;
export const SUPPORTED_DIGEST_ALGORITHMS = Object.freeze(["sha256"]);

const MAX_BATCH_ID_LENGTH = 128;
const MAX_IMPORTER_LENGTH = 120;
const HEX_64 = /^[0-9a-f]{64}$/;

export class ImportProvenanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ImportProvenanceError";
    this.code = code;
  }
}

function canonicalize(value) {
  if (value === null) return "null";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ImportProvenanceError("invalid_input", "record contains an invalid Date");
    }
    return JSON.stringify(value.toISOString());
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new ImportProvenanceError("invalid_input", "record contains a non-finite number");
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((item) => {
            if (item === undefined) {
              throw new ImportProvenanceError("invalid_input", "record contains an undefined array item");
            }
            return canonicalize(item);
          })
          .join(",")}]`;
      }
      const keys = Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
    }
    default:
      throw new ImportProvenanceError("invalid_input", `record contains an unsupported ${typeof value} value`);
  }
}

function hashHex(algorithm, text) {
  if (!SUPPORTED_DIGEST_ALGORITHMS.includes(algorithm)) {
    throw new ImportProvenanceError("unsupported_algorithm", `unsupported digest algorithm: ${algorithm}`);
  }
  return createHash(algorithm).update(text, "utf8").digest("hex");
}

function requireText(value, field, maxLength) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new ImportProvenanceError("invalid_input", `${field} must be a non-empty string up to ${maxLength} characters`);
  }
  return value.trim();
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new ImportProvenanceError("invalid_input", `${field} must be a positive integer`);
  }
  return value;
}

function toIsoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ImportProvenanceError("invalid_input", "recordedAt must be a valid timestamp");
  }
  return date.toISOString();
}

export function digestImportRecord({
  record,
  importBatchId,
  importerAddress,
  recordIndex,
  algorithm = "sha256",
} = {}) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new ImportProvenanceError("invalid_input", "record must be an object");
  }
  const payload = canonicalize({
    v: IMPORT_PROVENANCE_CHAIN_VERSION,
    batch: requireText(importBatchId, "importBatchId", MAX_BATCH_ID_LENGTH),
    importer: requireText(importerAddress, "importerAddress", MAX_IMPORTER_LENGTH),
    index: requirePositiveInteger(recordIndex, "recordIndex"),
    record,
  });
  return { digest: hashHex(algorithm, payload), algorithm };
}

function entryHashOf(fields) {
  return hashHex("sha256", canonicalize(fields));
}

function entryFields(entry) {
  return {
    seq: entry.seq,
    algorithm: entry.algorithm,
    digest: entry.digest,
    importBatchId: entry.importBatchId,
    importerAddress: entry.importerAddress,
    recordIndex: entry.recordIndex,
    recordedAt: entry.recordedAt,
    previousEntryHash: entry.previousEntryHash,
  };
}

export function createProvenanceEntry({
  seq,
  previousEntryHash = null,
  record,
  importBatchId,
  importerAddress,
  recordIndex,
  recordedAt,
  authorized,
  algorithm = "sha256",
} = {}) {
  if (authorized !== true) {
    throw new ImportProvenanceError("unauthorized", "importer is not authorized to create provenance entries");
  }
  const sequence = requirePositiveInteger(seq, "seq");
  if (previousEntryHash !== null && !(typeof previousEntryHash === "string" && HEX_64.test(previousEntryHash))) {
    throw new ImportProvenanceError("invalid_input", "previousEntryHash must be null or a sha256 hex digest");
  }
  if (sequence === 1 && previousEntryHash !== null) {
    throw new ImportProvenanceError("invalid_input", "the first entry must not reference a previous entry");
  }
  if (sequence > 1 && previousEntryHash === null) {
    throw new ImportProvenanceError("invalid_input", "later entries must reference the previous entry");
  }

  const { digest } = digestImportRecord({ record, importBatchId, importerAddress, recordIndex, algorithm });
  const entry = {
    seq: sequence,
    algorithm,
    digest,
    importBatchId: requireText(importBatchId, "importBatchId", MAX_BATCH_ID_LENGTH),
    importerAddress: requireText(importerAddress, "importerAddress", MAX_IMPORTER_LENGTH),
    recordIndex: requirePositiveInteger(recordIndex, "recordIndex"),
    recordedAt: toIsoTimestamp(recordedAt),
    previousEntryHash,
  };
  return { ...entry, entryHash: entryHashOf(entryFields(entry)) };
}

export function verifyProvenanceChain(entries, records) {
  if (!Array.isArray(entries) || !Array.isArray(records)) {
    throw new ImportProvenanceError("invalid_input", "entries and records must be arrays");
  }
  if (entries.length !== records.length) {
    throw new ImportProvenanceError(
      "sequence_gap",
      `chain has ${entries.length} entries but ${records.length} records were supplied`
    );
  }

  let previousHash = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") {
      throw new ImportProvenanceError("missing_entry", `entry ${index + 1} is missing`);
    }
    if (entry.seq !== index + 1) {
      throw new ImportProvenanceError(
        "sequence_gap",
        `entry at position ${index + 1} has seq ${entry.seq}; the chain is missing or reordered entries`
      );
    }
    if (entry.previousEntryHash !== previousHash) {
      throw new ImportProvenanceError("chain_broken", `entry ${entry.seq} does not link to the previous entry`);
    }
    if (entryHashOf(entryFields(entry)) !== entry.entryHash) {
      throw new ImportProvenanceError("entry_tampered", `entry ${entry.seq} fields do not match its hash`);
    }
    const record = records[index];
    if (record === undefined) {
      throw new ImportProvenanceError("missing_record", `no record supplied for entry ${entry.seq}`);
    }
    const { digest } = digestImportRecord({
      record,
      importBatchId: entry.importBatchId,
      importerAddress: entry.importerAddress,
      recordIndex: entry.recordIndex,
      algorithm: entry.algorithm,
    });
    if (digest !== entry.digest) {
      throw new ImportProvenanceError("digest_mismatch", `record for entry ${entry.seq} was altered after import`);
    }
    previousHash = entry.entryHash;
  }

  return { valid: true, length: entries.length, headHash: previousHash };
}

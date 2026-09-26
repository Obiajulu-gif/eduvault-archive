import { sanitizeString, normalizeStringList } from "../api/validation.js";
import { isSafeUrl } from "../api/safeUrl.js";
import { sanitizeRichText } from "../api/contentSanitizer.js";
import {
  normalizeSubject,
  normalizeCategory,
  normalizeLevel,
} from "./taxonomy.js";

const REQUIRED_FIELDS = ["title", "storageKey"];
const OPTIONAL_FIELDS = [
  "externalId", "description", "shortSummary", "price", "usageRights", "visibility",
  "coverImageUrl", "thumbnailUrl", "category", "subject", "level",
  "learningOutcomes", "tableOfContents", "sampleNotes",
];

const SUPPORTED_FORMATS = ["csv", "json"];

export class ImportValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ImportValidationError";
    this.details = details;
  }
}

export function validateImportSchema(body) {
  const format = sanitizeString(body?.format, { maxLength: 10 }) || "json";
  if (!SUPPORTED_FORMATS.includes(format)) {
    throw new ImportValidationError(`Unsupported import format: "${format}". Supported: ${SUPPORTED_FORMATS.join(", ")}`, { field: "format" });
  }

  const dryRun = body?.dryRun !== false;

  let records;
  if (body?.records && Array.isArray(body.records)) {
    records = body.records;
  } else if (body?.items && Array.isArray(body.items)) {
    records = body.items;
  } else {
    throw new ImportValidationError("Import payload must contain a 'records' or 'items' array");
  }

  if (records.length === 0) {
    throw new ImportValidationError("Import payload contains no records");
  }

  if (records.length > 500) {
    throw new ImportValidationError("Maximum 500 records per import", { maxRecords: 500, received: records.length });
  }

  return { format, dryRun, records };
}

export function validateImportRow(row, index) {
  const errors = [];

  const title = sanitizeString(row?.title, { maxLength: 160 });
  if (!title) {
    errors.push({ field: "title", message: "Title is required" });
  }

  const storageKey = sanitizeString(row?.storageKey || row?.fileUrl, { maxLength: 2048 });
  if (!storageKey) {
    errors.push({ field: "storageKey", message: "storageKey or fileUrl is required" });
  }

  const externalId = sanitizeString(row?.externalId, { maxLength: 128 }) || null;

  for (const field of ["coverImageUrl", "thumbnailUrl"]) {
    const url = sanitizeString(row?.[field], { maxLength: 2048 });
    if (url && !isSafeUrl(url)) {
      errors.push({ field, message: `Unsafe or invalid URL for ${field}` });
    }
  }

  let price = 0;
  if (row?.price !== undefined && row?.price !== null && row?.price !== "") {
    price = Number(row.price);
    if (!Number.isFinite(price) || price < 0) {
      errors.push({ field: "price", message: `Invalid price: "${row.price}"` });
    }
  }

  let visibility = sanitizeString(row?.visibility, { maxLength: 20 }) || "private";
  if (!["private", "public", "unlisted"].includes(visibility)) {
    errors.push({ field: "visibility", message: `Invalid visibility: "${visibility}". Must be private, public, or unlisted` });
  }

  let category = null;
  if (row?.category) {
    const normalized = normalizeCategory(row.category);
    if (!normalized) {
      errors.push({ field: "category", message: `Unknown category: "${row.category}"` });
    } else {
      category = normalized.id;
    }
  }

  let subject = null;
  if (row?.subject) {
    const normalized = normalizeSubject(row.subject);
    if (!normalized) {
      errors.push({ field: "subject", message: `Unknown subject: "${row.subject}"` });
    } else {
      subject = normalized.id;
      if (!category) category = normalized.categoryId;
    }
  }

  let level = null;
  if (row?.level) {
    const normalized = normalizeLevel(row.level);
    if (!normalized) {
      errors.push({ field: "level", message: `Unknown level: "${row.level}"` });
    } else {
      level = normalized.id;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, row: index + 1 };
  }

  return {
    valid: true,
    data: {
      externalId,
      title,
      description: sanitizeRichText(sanitizeString(row?.description, { maxLength: 5000 })),
      shortSummary: sanitizeString(row?.shortSummary, { maxLength: 280 }) || "",
      price,
      usageRights: sanitizeString(row?.usageRights, { maxLength: 1000 }) || "",
      visibility,
      coverImageUrl: sanitizeString(row?.coverImageUrl, { maxLength: 2048 }) || null,
      thumbnailUrl: sanitizeString(row?.thumbnailUrl, { maxLength: 2048 }) || null,
      category,
      subject,
      level,
      learningOutcomes: normalizeStringList(row?.learningOutcomes, { maxItems: 8, maxLength: 180 }),
      tableOfContents: normalizeStringList(row?.tableOfContents, { maxItems: 16, maxLength: 180 }),
      sampleNotes: normalizeStringList(row?.sampleNotes, { maxItems: 6, maxLength: 280 }),
      storageKey,
      fileUrl: storageKey,
    },
    row: index + 1,
  };
}

export function validateImportPayload(body) {
  const { format, dryRun, records } = validateImportSchema(body);

  const results = records.map((row, index) => validateImportRow(row, index));

  const validRecords = results.filter((r) => r.valid).map((r) => r.data);
  const invalidRows = results.filter((r) => !r.valid).map((r) => ({
    row: r.row,
    errors: r.errors,
  }));

  return {
    format,
    dryRun,
    total: records.length,
    valid: validRecords.length,
    invalid: invalidRows.length,
    validRecords,
    invalidRows,
    results,
  };
}

// Fields an import may overwrite on a material it already created. Ownership,
// quarantine, and on-chain fields are never touched by a re-import.
const IMPORT_UPDATABLE_FIELDS = [
  "title", "description", "shortSummary", "price", "usageRights", "visibility",
  "coverImageUrl", "thumbnailUrl", "category", "subject", "level",
  "learningOutcomes", "tableOfContents", "sampleNotes",
];

function changedFields(existing, record) {
  return IMPORT_UPDATABLE_FIELDS.filter(
    (field) => JSON.stringify(existing[field] ?? null) !== JSON.stringify(record[field] ?? null)
  );
}

/**
 * Decide what each row would do, without touching the database. `existing` is
 * the caller's materials matching the batch's externalIds or storageKeys.
 *
 *   create — new material
 *   update — externalId matches an existing material and fields differ
 *   skip   — externalId matches with no changes, or storageKey already imported
 *   error  — failed validation, or duplicates an earlier row in the same batch
 *
 * Rows with an externalId are idempotent: re-running the same file yields all
 * skips. Rows without one can't be matched for updates, so a repeated
 * storageKey is skipped rather than creating a second copy.
 */
export function planImport(validation, existing = []) {
  const byExternalId = new Map();
  const byStorageKey = new Map();
  for (const doc of existing) {
    if (doc.externalId) byExternalId.set(doc.externalId, doc);
    if (doc.storageKey) byStorageKey.set(doc.storageKey, doc);
  }

  const seenExternalIds = new Map();
  const seenStorageKeys = new Map();
  const rows = [];

  for (const result of validation.results) {
    if (!result.valid) {
      rows.push({ row: result.row, action: "error", errors: result.errors });
      continue;
    }

    const record = result.data;
    const duplicateOf = (record.externalId && seenExternalIds.get(record.externalId))
      || seenStorageKeys.get(record.storageKey);
    if (duplicateOf) {
      rows.push({
        row: result.row,
        action: "error",
        errors: [{ field: record.externalId ? "externalId" : "storageKey", message: `Duplicate of row ${duplicateOf} in this batch` }],
      });
      continue;
    }
    if (record.externalId) seenExternalIds.set(record.externalId, result.row);
    seenStorageKeys.set(record.storageKey, result.row);

    const match = record.externalId ? byExternalId.get(record.externalId) : null;
    if (match) {
      const fields = changedFields(match, record);
      rows.push(fields.length > 0
        ? { row: result.row, action: "update", externalId: record.externalId, materialId: String(match._id), fields, record, previous: match }
        : { row: result.row, action: "skip", externalId: record.externalId, materialId: String(match._id), reason: "No changes" });
      continue;
    }

    const sameFile = byStorageKey.get(record.storageKey);
    if (sameFile) {
      rows.push({ row: result.row, action: "skip", externalId: record.externalId, materialId: String(sameFile._id), reason: "storageKey already imported" });
      continue;
    }

    rows.push({ row: result.row, action: "create", externalId: record.externalId, record });
  }

  const summary = { create: 0, update: 0, skip: 0, error: 0 };
  for (const r of rows) summary[r.action] += 1;
  return { summary, rows };
}

/** Plan rows without the internal `record`/`previous` payloads, for API responses. */
export function publicPlanRows(rows) {
  return rows.map(({ record: _record, previous: _previous, ...rest }) => rest);
}

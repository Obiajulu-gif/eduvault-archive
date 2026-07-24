import { sanitizeString, normalizeStringList, normalizeImageField } from "../api/validation.js";
import {
  normalizeSubject,
  normalizeCategory,
  normalizeLevel,
} from "./taxonomy.js";

const REQUIRED_FIELDS = ["title", "storageKey"];
const OPTIONAL_FIELDS = [
  "description", "shortSummary", "price", "usageRights", "visibility",
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
  const images = {};

  for (const [field, value] of [
    ["coverImageUrl", row?.coverImageUrl],
    ["thumbnailUrl", row?.thumbnailUrl],
  ]) {
    try {
      images[field] = normalizeImageField(value, field);
    } catch (error) {
      errors.push({ field, message: error.message });
    }
  }

  const title = sanitizeString(row?.title, { maxLength: 160 });
  if (!title) {
    errors.push({ field: "title", message: "Title is required" });
  }

  const storageKey = sanitizeString(row?.storageKey || row?.fileUrl, { maxLength: 2048 });
  if (!storageKey) {
    errors.push({ field: "storageKey", message: "storageKey or fileUrl is required" });
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
      title,
      description: sanitizeString(row?.description, { maxLength: 5000 }) || "",
      shortSummary: sanitizeString(row?.shortSummary, { maxLength: 280 }) || "",
      price,
      usageRights: sanitizeString(row?.usageRights, { maxLength: 1000 }) || "",
      visibility,
      ...images,
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
  };
}

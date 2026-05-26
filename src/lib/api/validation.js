export class ValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;
const MATERIAL_VISIBILITY_VALUES = ["private", "public", "unlisted"];
const MATERIAL_FILE_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const THUMBNAIL_FILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MATERIAL_FILE_MAX_BYTES = 10 * 1024 * 1024;
const THUMBNAIL_FILE_MAX_BYTES = 5 * 1024 * 1024;

function addValidationError(errors, field, message, code = "invalid") {
  errors.push({ field, message, code });
}

function validationError(errors, message = "Invalid material payload") {
  return new ValidationError(message, { errors });
}

function sanitizeText(value, { maxLength = 5000 } = {}) {
  if (value === undefined || value === null) return "";
  return String(value).replace(CONTROL_CHARS, "").trim().slice(0, maxLength);
}

export function sanitizeString(value, options) {
  return sanitizeText(value, options);
}

export function sanitizeObject(input, fieldLimits = {}) {
  return Object.fromEntries(
    Object.entries(input || {}).map(([key, value]) => [
      sanitizeText(key, { maxLength: 80 }),
      typeof value === "string"
        ? sanitizeText(value, { maxLength: fieldLimits[key] || 5000 })
        : value,
    ])
  );
}

export function validateEmail(email) {
  const clean = sanitizeText(email, { maxLength: 254 }).toLowerCase();
  if (!EMAIL_PATTERN.test(clean)) {
    throw new ValidationError("Invalid email address", { field: "email" });
  }
  return clean;
}

export function normalizeWalletAddress(address) {
  const clean = sanitizeText(address, { maxLength: 80 });
  if (!clean) return null;
  if (!EVM_ADDRESS_PATTERN.test(clean) && !STELLAR_ADDRESS_PATTERN.test(clean)) {
    throw new ValidationError("Invalid wallet address", { field: "walletAddress" });
  }
  return clean;
}

export function validateProfilePayload(body) {
  const fullName = sanitizeText(body?.fullName, { maxLength: 120 });
  if (!fullName) {
    throw new ValidationError("Missing fullName", { field: "fullName" });
  }

  const email = validateEmail(body?.email);
  const walletAddress = normalizeWalletAddress(body?.walletAddress);

  return {
    fullName,
    email,
    institution: sanitizeText(body?.institution, { maxLength: 160 }) || null,
    country: sanitizeText(body?.country, { maxLength: 80 }) || null,
    bio: sanitizeText(body?.bio, { maxLength: 1000 }) || null,
    walletAddress,
    walletAddressLower: walletAddress ? walletAddress.toLowerCase() : null,
  };
}

export function parsePagination(searchParams, { defaultPageSize = 12, maxPageSize = 50 } = {}) {
  const page = Math.max(1, Number(searchParams.get("page") || "1"));
  const pageSize = Math.max(
    1,
    Math.min(maxPageSize, Number(searchParams.get("pageSize") || String(defaultPageSize)))
  );
  return { page, pageSize };
}

export function escapeRegExp(value) {
  return sanitizeText(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeMaybeString(value, { maxLength, collapseWhitespace = true, lowerCase = false } = {}) {
  if (value === undefined || value === null) return null;
  const base = sanitizeText(value, { maxLength });
  if (!base) return null;
  const normalized = collapseWhitespace ? base.replace(/\s+/g, " ") : base;
  return lowerCase ? normalized.toLowerCase() : normalized;
}

function normalizeUrlField(value, { field, errors, maxLength = 2048, required = false } = {}) {
  const clean = normalizeMaybeString(value, { maxLength, collapseWhitespace: false });
  if (!clean) {
    if (required) addValidationError(errors, field, `${field} is required`, "required");
    return null;
  }

  try {
    const url = new URL(clean);
    if (!["http:", "https:", "ipfs:"].includes(url.protocol)) {
      addValidationError(errors, field, `${field} must use http, https, or ipfs`, "invalid_url");
      return null;
    }
    return url.toString();
  } catch {
    addValidationError(errors, field, `${field} must be a valid URL`, "invalid_url");
    return null;
  }
}

function normalizeNumericField(value, { field, errors, required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) addValidationError(errors, field, `${field} is required`, "required");
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    addValidationError(errors, field, `${field} must be a non-negative number`, "invalid_number");
    return null;
  }

  return number;
}

function normalizeFileMetadata(body, { fieldPrefix, errors }) {
  const typeField = `${fieldPrefix}Type`;
  const sizeField = `${fieldPrefix}Size`;
  const typeValue = normalizeMaybeString(body?.[typeField], { maxLength: 120, lowerCase: true });
  const sizeValue = body?.[sizeField];

  if (typeValue === null && sizeValue === undefined) {
    return {};
  }

  if (typeValue === null) {
    addValidationError(errors, typeField, `${typeField} is required when ${sizeField} is provided`, "required");
    return {};
  }

  if (sizeValue === undefined || sizeValue === null || sizeValue === "") {
    addValidationError(errors, sizeField, `${sizeField} is required when ${typeField} is provided`, "required");
    return {};
  }

  const size = Number(sizeValue);
  if (!Number.isFinite(size) || size <= 0) {
    addValidationError(errors, sizeField, `${sizeField} must be a positive number`, "invalid_number");
    return {};
  }

  const allowedTypes = fieldPrefix === "thumbnail" ? THUMBNAIL_FILE_TYPES : MATERIAL_FILE_TYPES;
  const maxBytes = fieldPrefix === "thumbnail" ? THUMBNAIL_FILE_MAX_BYTES : MATERIAL_FILE_MAX_BYTES;

  if (!allowedTypes.has(typeValue)) {
    addValidationError(errors, typeField, `${fieldPrefix} type is not supported`, "unsupported_file_type");
    return {};
  }

  if (size > maxBytes) {
    addValidationError(errors, sizeField, `${fieldPrefix} is too large`, "file_too_large");
    return {};
  }

  return {
    [typeField]: typeValue,
    [sizeField]: size,
  };
}

function normalizeMaterialPayload(body, { partial = false } = {}) {
  const errors = [];

  const title = normalizeMaybeString(body?.title, { maxLength: 160 });
  if (!title && !partial) {
    addValidationError(errors, "title", "title is required", "required");
  }

  const fileUrl = normalizeUrlField(body?.fileUrl, {
    field: "fileUrl",
    errors,
    required: !partial,
  });

  const thumbnailUrl = normalizeUrlField(body?.thumbnailUrl, {
    field: "thumbnailUrl",
    errors,
  });

  const visibilityRaw = normalizeMaybeString(body?.visibility, {
    maxLength: 20,
    lowerCase: true,
  });
  let visibility = visibilityRaw;
  if (!visibility && !partial) {
    visibility = "private";
  }
  if (visibility && !MATERIAL_VISIBILITY_VALUES.includes(visibility)) {
    addValidationError(errors, "visibility", "visibility is not supported", "unsupported_value");
  }

  const price = normalizeNumericField(body?.price, { field: "price", errors });
  const usageRights = normalizeMaybeString(body?.usageRights, { maxLength: 1000 });
  const description = normalizeMaybeString(body?.description, { maxLength: 5000 });

  const fileMetadata = normalizeFileMetadata(body, { fieldPrefix: "file", errors });
  const thumbnailMetadata = normalizeFileMetadata(body, { fieldPrefix: "thumbnail", errors });

  const chainFields = {
    materialId: normalizeMaybeString(body?.materialId, { maxLength: 160 }),
    chainContractId: normalizeMaybeString(body?.chainContractId, { maxLength: 160 }),
    chainLedger: normalizeMaybeString(body?.chainLedger, { maxLength: 80 }),
    chainTxHash: normalizeMaybeString(body?.chainTxHash, { maxLength: 120, lowerCase: true }),
    syncStatus: normalizeMaybeString(body?.syncStatus, { maxLength: 40, lowerCase: true }),
  };

  if (errors.length > 0) {
    throw validationError(errors);
  }

  const payload = {
    ...(title ? { title: sanitizeText(title, { maxLength: 160 }).replace(/\s+/g, " ") } : {}),
    ...(description !== null ? { description } : {}),
    ...(usageRights !== null ? { usageRights: sanitizeText(usageRights, { maxLength: 1000 }).replace(/\s+/g, " ") } : {}),
    ...(visibility ? { visibility } : {}),
    ...(price !== null ? { price } : {}),
    ...(fileUrl ? { fileUrl } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : !partial ? { thumbnailUrl: null } : {}),
    ...fileMetadata,
    ...thumbnailMetadata,
    ...Object.fromEntries(Object.entries(chainFields).filter(([, value]) => value)),
  };

  if (partial) {
    return payload;
  }

  return {
    title: payload.title,
    fileUrl: payload.fileUrl,
    visibility: payload.visibility || "private",
    price: payload.price ?? 0,
    description: payload.description || "",
    usageRights: payload.usageRights || "",
    thumbnailUrl: payload.thumbnailUrl || null,
    ...fileMetadata,
    ...thumbnailMetadata,
    ...Object.fromEntries(Object.entries(chainFields).filter(([, value]) => value)),
  };
}

export function validateMaterialCreatePayload(body) {
  return normalizeMaterialPayload(body, { partial: false });
}

export function validateMaterialUpdatePayload(body) {
  return normalizeMaterialPayload(body, { partial: true });
}

export function validateMaterialPayload(body) {
  return validateMaterialCreatePayload(body);
}

export {
  MATERIAL_FILE_MAX_BYTES,
  THUMBNAIL_FILE_MAX_BYTES,
  MATERIAL_VISIBILITY_VALUES,
};

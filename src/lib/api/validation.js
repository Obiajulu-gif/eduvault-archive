import {
  normalizeSubject,
  normalizeCategory,
  normalizeLevel,
  validateCategorySubject,
} from "../backend/taxonomy.js";

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
const CURRENCY_CODE_PATTERN = /^[A-Z][A-Z0-9]{2,11}$/;

export function sanitizeString(value, { maxLength = 5000 } = {}) {
  if (value === undefined || value === null) return "";
  return String(value).replace(CONTROL_CHARS, "").trim().slice(0, maxLength);
}

export function sanitizeObject(input, fieldLimits = {}) {
  return Object.fromEntries(
    Object.entries(input || {}).map(([key, value]) => [
      sanitizeString(key, { maxLength: 80 }),
      typeof value === "string"
        ? sanitizeString(value, { maxLength: fieldLimits[key] || 5000 })
        : value,
    ])
  );
}

export function normalizeStringList(value, { maxItems = 8, maxLength = 240 } = {}) {
  if (value === undefined || value === null) return [];

  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|,/g)
      : [];

  return items
    .map((item) => sanitizeString(item, { maxLength }))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function validateEmail(email) {
  const clean = sanitizeString(email, { maxLength: 254 }).toLowerCase();
  if (!EMAIL_PATTERN.test(clean)) {
    throw new ValidationError("Invalid email address", { field: "email" });
  }
  return clean;
}

export function normalizeWalletAddress(address) {
  const clean = sanitizeString(address, { maxLength: 80 });
  if (!clean) return null;
  if (!EVM_ADDRESS_PATTERN.test(clean) && !STELLAR_ADDRESS_PATTERN.test(clean)) {
    throw new ValidationError("Invalid wallet address", { field: "walletAddress" });
  }
  return clean;
}

export function normalizeCurrencyCode(currency) {
  const clean = sanitizeString(currency, { maxLength: 12 }).toUpperCase();
  if (!clean) return null;
  if (!CURRENCY_CODE_PATTERN.test(clean)) {
    throw new ValidationError("Invalid currency code", { field: "preferredPayoutCurrency" });
  }
  return clean;
}

export function validateProfilePayload(body) {
  const fullName = sanitizeString(body?.fullName, { maxLength: 120 });
  if (!fullName) {
    throw new ValidationError("Missing fullName", { field: "fullName" });
  }

  const email = validateEmail(body?.email);
  const walletAddress = normalizeWalletAddress(body?.walletAddress);

  return {
    fullName,
    email,
    institution: sanitizeString(body?.institution, { maxLength: 160 }) || null,
    country: sanitizeString(body?.country, { maxLength: 80 }) || null,
    bio: sanitizeString(body?.bio, { maxLength: 1000 }) || null,
    avatarUrl: sanitizeString(body?.avatarUrl, { maxLength: 2048 }) || null,
    twitterUrl: sanitizeString(body?.twitterUrl, { maxLength: 256 }) || null,
    githubUrl: sanitizeString(body?.githubUrl, { maxLength: 256 }) || null,
    websiteUrl: sanitizeString(body?.websiteUrl, { maxLength: 256 }) || null,
    walletAddress,
    walletAddressLower: walletAddress ? walletAddress.toLowerCase() : null,
  };
}

export function validatePayoutSettingsPayload(body) {
  const payoutWalletAddress =
    body?.payoutWalletAddress === undefined ? undefined : normalizeWalletAddress(body.payoutWalletAddress);
  const preferredPayoutCurrency =
    body?.preferredPayoutCurrency === undefined ? undefined : normalizeCurrencyCode(body.preferredPayoutCurrency);
  const payoutNotes =
    body?.payoutNotes === undefined ? undefined : (sanitizeString(body.payoutNotes, { maxLength: 1000 }) || null);

  return {
    payoutWalletAddress,
    payoutWalletAddressLower: payoutWalletAddress ? payoutWalletAddress.toLowerCase() : null,
    preferredPayoutCurrency,
    payoutNotes,
  };
}

export function validateMaterialPayload(body) {
  const title = sanitizeString(body?.title, { maxLength: 160 });
  const storageKey = sanitizeString(body?.storageKey || body?.fileUrl, { maxLength: 2048 });
  if (!title || !storageKey) {
    throw new ValidationError("Missing required material fields (title or storageKey)");
  }

  const price = Number(body?.price ?? 0);
  if (!Number.isFinite(price) || price < 0) {
    throw new ValidationError("Invalid price", { field: "price" });
  }

  const visibility = sanitizeString(body?.visibility, { maxLength: 20 }) || "private";
  if (!["private", "public", "unlisted"].includes(visibility)) {
    throw new ValidationError("Invalid visibility", { field: "visibility" });
  }

  const rawCategory = sanitizeString(body?.category, { maxLength: 60 });
  const rawSubject = sanitizeString(body?.subject, { maxLength: 60 });
  const rawLevel = sanitizeString(body?.level, { maxLength: 60 });

  let category = null;
  let subject = null;
  let level = null;

  if (rawCategory) {
    const normalized = normalizeCategory(rawCategory);
    if (!normalized) {
      throw new ValidationError(`Unknown category: "${rawCategory}"`, { field: "category" });
    }
    category = normalized.id;
  }

  if (rawSubject) {
    const normalized = normalizeSubject(rawSubject);
    if (!normalized) {
      throw new ValidationError(`Unknown subject: "${rawSubject}"`, { field: "subject" });
    }
    subject = normalized.id;

    if (!category) {
      category = normalized.categoryId;
    }
  }

  if (category && subject) {
    const validation = validateCategorySubject(category, subject);
    if (!validation.valid) {
      throw new ValidationError(validation.error, { field: "subject" });
    }
  }

  if (rawLevel) {
    const normalized = normalizeLevel(rawLevel);
    if (!normalized) {
      throw new ValidationError(`Unknown level: "${rawLevel}"`, { field: "level" });
    }
    level = normalized.id;
  }

  return {
    title,
    description: sanitizeString(body?.description, { maxLength: 5000 }),
    shortSummary: sanitizeString(body?.shortSummary, { maxLength: 280 }),
    price,
    usageRights: sanitizeString(body?.usageRights, { maxLength: 1000 }),
    visibility,
    coverImageUrl: sanitizeString(body?.coverImageUrl, { maxLength: 2048 }) || null,
    thumbnailUrl: sanitizeString(body?.thumbnailUrl, { maxLength: 2048 }) || null,
    tokenId: sanitizeString(body?.tokenId, { maxLength: 80 }) || null,
    txHash: sanitizeString(body?.txHash, { maxLength: 100 }) || null,
    category,
    subject,
    level,
    learningOutcomes: normalizeStringList(body?.learningOutcomes, {
      maxItems: 8,
      maxLength: 180,
    }),
    tableOfContents: normalizeStringList(body?.tableOfContents, {
      maxItems: 16,
      maxLength: 180,
    }),
    sampleNotes: normalizeStringList(body?.sampleNotes, {
      maxItems: 6,
      maxLength: 280,
    }),
    storageKey,
    fileUrl: storageKey,
  };
}

export function validateMaterialUpdatePayload(body) {
  const allowed = {};

  if (body.title !== undefined) {
    const title = sanitizeString(body.title, { maxLength: 160 });
    if (!title) throw new ValidationError("Title cannot be empty", { field: "title" });
    allowed.title = title;
  }

  if (body.description !== undefined) {
    allowed.description = sanitizeString(body.description, { maxLength: 5000 });
  }

  if (body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) {
      throw new ValidationError("Invalid price", { field: "price" });
    }
    allowed.price = price;
  }

  if (body.usageRights !== undefined) {
    allowed.usageRights = sanitizeString(body.usageRights, { maxLength: 1000 });
  }

  if (body.visibility !== undefined) {
    const visibility = sanitizeString(body.visibility, { maxLength: 20 });
    if (!["private", "public", "unlisted"].includes(visibility)) {
      throw new ValidationError("Invalid visibility", { field: "visibility" });
    }
    allowed.visibility = visibility;
  }

  if (body.thumbnailUrl !== undefined) {
    allowed.thumbnailUrl = sanitizeString(body.thumbnailUrl, { maxLength: 2048 }) || null;
  }

  if (body.category !== undefined) {
    const raw = sanitizeString(body.category, { maxLength: 60 });
    if (raw) {
      const normalized = normalizeCategory(raw);
      if (!normalized) throw new ValidationError(`Unknown category: "${raw}"`, { field: "category" });
      allowed.category = normalized.id;
    } else {
      allowed.category = null;
    }
  }

  if (body.subject !== undefined) {
    const raw = sanitizeString(body.subject, { maxLength: 60 });
    if (raw) {
      const normalized = normalizeSubject(raw);
      if (!normalized) throw new ValidationError(`Unknown subject: "${raw}"`, { field: "subject" });
      allowed.subject = normalized.id;
    } else {
      allowed.subject = null;
    }
  }

  if (body.level !== undefined) {
    const raw = sanitizeString(body.level, { maxLength: 60 });
    if (raw) {
      const normalized = normalizeLevel(raw);
      if (!normalized) throw new ValidationError(`Unknown level: "${raw}"`, { field: "level" });
      allowed.level = normalized.id;
    } else {
      allowed.level = null;
    }
  }

  if (Object.keys(allowed).length === 0) {
    throw new ValidationError("No editable fields provided");
  }

  return allowed;
}

export function validateChangeReason(reason) {
  if (!reason) return null;
  return sanitizeString(reason, { maxLength: 500 });
}

export function validateDateRangeQuery(searchParams, { maxRangeDays = 366, defaultRangeDays = 30 } = {}) {
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");

  const to = toParam ? new Date(toParam) : new Date();
  if (Number.isNaN(to.getTime())) {
    throw new ValidationError("Invalid 'to' date", { field: "to" });
  }

  const from = fromParam
    ? new Date(fromParam)
    : new Date(to.getTime() - defaultRangeDays * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime())) {
    throw new ValidationError("Invalid 'from' date", { field: "from" });
  }

  if (from > to) {
    throw new ValidationError("'from' date must not be after 'to' date", { field: "from" });
  }

  const rangeDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  if (rangeDays > maxRangeDays) {
    throw new ValidationError(`Date range cannot exceed ${maxRangeDays} days`, { field: "from" });
  }

  return { from, to };
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
  return sanitizeString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LICENSE_TYPES = [
  "Standard License (download only)",
  "Creative Commons",
  "Private Use Only",
];

export function validatePrice(value, { allowZero = true } = {}) {
  const price = Number(value ?? 0);
  if (!Number.isFinite(price) || price < 0) {
    throw new ValidationError("Price must be a non-negative number", { field: "price" });
  }
  if (!allowZero && price === 0) {
    throw new ValidationError("Price must be greater than 0", { field: "price" });
  }
  if (price > 1000000) {
    throw new ValidationError("Price cannot exceed 1,000,000", { field: "price" });
  }
  return price;
}

export function validateLicense(value) {
  const clean = sanitizeString(value, { maxLength: 200 });
  if (!clean) return null;
  const match = LICENSE_TYPES.find(
    (t) => t.toLowerCase() === clean.toLowerCase()
  );
  if (!match) {
    throw new ValidationError(
      `Invalid usage rights: "${clean}". Allowed: ${LICENSE_TYPES.join(", ")}`,
      { field: "usageRights" }
    );
  }
  return match;
}

export function validateUploadPayload(body) {
  const title = sanitizeString(body?.title, { maxLength: 160 });
  if (!title) {
    throw new ValidationError("Title is required", { field: "title" });
  }

  const description = sanitizeString(body?.description, { maxLength: 5000 });

  const price = validatePrice(body?.price);

  const usageRights = validateLicense(body?.usageRights);

  const visibility = sanitizeString(body?.visibility, { maxLength: 20 }) || "private";
  if (!["private", "public", "unlisted"].includes(visibility)) {
    throw new ValidationError("Invalid visibility", { field: "visibility" });
  }

  return { title, description, price, usageRights, visibility };
}

export function validateUploadFileMetadata(file, field) {
  if (!file) {
    throw new ValidationError("No file provided", { field });
  }

  const maxSize = 10 * 1024 * 1024;

  if (typeof file.size !== "number" || typeof file.type !== "string") {
    throw new ValidationError("Invalid file metadata: missing size or type", { field });
  }

  const sizeMB = (file.size / (1024 * 1024)).toFixed(2);

  if (file.size > maxSize) {
    throw new ValidationError(
      `File size ${sizeMB}MB exceeds 10MB limit`,
      { field }
    );
  }

  const allowedDocumentTypes = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "application/zip",
    "application/x-zip-compressed",
  ];

  const allowedVideoTypes = [
    "video/mp4",
    "video/mpeg",
    "video/quicktime",
    "video/x-msvideo",
    "video/webm",
    "video/ogg",
    "video/x-matroska",
  ];

  const allowedTypes = [...allowedDocumentTypes, ...allowedVideoTypes];

  if (!allowedTypes.includes(file.type)) {
    throw new ValidationError(
      `Unsupported file type: ${file.type || "unknown"}. Allowed: PDF, DOC, DOCX, PPT, PPTX, XLS, XLSX, TXT, ZIP, MP4, MOV, AVI, WEBM, MKV`,
      { field }
    );
  }

  return {
    size: file.size,
    sizeMB,
    type: file.type,
    name: file.name || null,
    isVideo: allowedVideoTypes.includes(file.type),
  };
}

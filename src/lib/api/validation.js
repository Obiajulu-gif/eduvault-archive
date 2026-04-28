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
    walletAddress,
    walletAddressLower: walletAddress ? walletAddress.toLowerCase() : null,
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

  return {
    title,
    description: sanitizeString(body?.description, { maxLength: 5000 }),
    price,
    usageRights: sanitizeString(body?.usageRights, { maxLength: 1000 }),
    visibility,
    thumbnailUrl: sanitizeString(body?.thumbnailUrl || body?.thumbnail, { maxLength: 2048 }) || null,
    metadataUrl: sanitizeString(body?.metadataUrl || body?.metadata, { maxLength: 2048 }) || null,
    storageKey,
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
  return sanitizeString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

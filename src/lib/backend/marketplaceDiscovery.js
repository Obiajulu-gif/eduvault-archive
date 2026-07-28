export const LICENSE_OPTIONS = [
  { id: "standard", label: "Standard License (download only)", value: "Standard License (download only)" },
  { id: "creative-commons", label: "Creative Commons", value: "Creative Commons" },
  { id: "private-use", label: "Private Use Only", value: "Private Use Only" },
];

export const CONTENT_TYPE_OPTIONS = [
  { id: "pdf", label: "PDF" },
  { id: "word", label: "Word" },
  { id: "presentation", label: "Presentation" },
  { id: "spreadsheet", label: "Spreadsheet" },
  { id: "text", label: "Text" },
  { id: "zip", label: "ZIP" },
];

export const NEWEST_OPTIONS = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
];

const CONTENT_TYPE_PATTERNS = {
  pdf: ["pdf", "application/pdf"],
  word: ["doc", "docx", "word", "msword", "officedocument.wordprocessingml"],
  presentation: ["ppt", "pptx", "powerpoint", "presentationml"],
  spreadsheet: ["xls", "xlsx", "excel", "spreadsheetml"],
  text: ["txt", "text/plain"],
  zip: ["zip", "application/zip", "x-zip-compressed"],
};

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function sanitizeString(value, { maxLength = 5000 } = {}) {
  if (value === undefined || value === null) return "";
  return String(value).replace(CONTROL_CHARS, "").trim().slice(0, maxLength);
}

function escapeRegExp(value) {
  return sanitizeString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numberParam(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getLicenseValue(value) {
  const clean = sanitizeString(value, { maxLength: 120 });
  if (!clean) return null;
  return LICENSE_OPTIONS.find((option) => option.id === clean || option.value === clean)?.value || clean;
}

function getNewestDate(value, now = new Date()) {
  const clean = sanitizeString(value, { maxLength: 20 });
  const option = NEWEST_OPTIONS.find((item) => item.id === clean);
  if (!option) return null;

  const date = new Date(now);
  date.setDate(date.getDate() - option.days);
  return date;
}

function buildContentTypeQuery(value) {
  const clean = sanitizeString(value, { maxLength: 60 }).toLowerCase();
  const patterns = CONTENT_TYPE_PATTERNS[clean];
  if (!patterns) return null;

  const regex = new RegExp(patterns.map(escapeRegExp).join("|"), "i");
  return {
    $or: [
      { fileType: regex },
      { contentType: regex },
      { mimeType: regex },
      { fileName: regex },
      { storageKey: regex },
    ],
  };
}

export function buildMarketplaceDiscoveryQuery(searchParams, { now = new Date() } = {}) {
  const query = {
    visibility: "public",
    moderationStatus: { $ne: "suspended" },
    $or: [
      { relevanceStatus: { $exists: false } },
      { relevanceStatus: { $ne: "low" } },
    ],
  };
  const andClauses = [];

  const search = sanitizeString(searchParams.get("search"), { maxLength: 120 });
  if (search) {
    const regex = new RegExp(escapeRegExp(search), "i");
    andClauses.push({
      $or: [
        { title: regex },
        { description: regex },
        { shortSummary: regex },
        { author: regex },
        { subject: regex },
      ],
    });
  }

  const subject = sanitizeString(searchParams.get("subject"), { maxLength: 80 });
  const category = sanitizeString(searchParams.get("category"), { maxLength: 80 });
  const level = sanitizeString(searchParams.get("level"), { maxLength: 80 });
  const creator = sanitizeString(searchParams.get("creator"), { maxLength: 120 });
  const licenseType = getLicenseValue(searchParams.get("licenseType") || searchParams.get("usageRights"));
  const contentTypeQuery = buildContentTypeQuery(searchParams.get("contentType"));
  const minPrice = numberParam(searchParams.get("minPrice"));
  const maxPrice = numberParam(searchParams.get("maxPrice"));
  const minRating = numberParam(searchParams.get("minRating"));
  const newestDate = getNewestDate(searchParams.get("newest"), now);

  if (subject) query.subject = subject;
  if (category) query.category = category;
  if (level) query.level = level;
  if (creator) query.author = creator;
  if (licenseType) query.usageRights = licenseType;
  if (contentTypeQuery) andClauses.push(contentTypeQuery);

  if (minPrice !== null || maxPrice !== null) {
    query.price = {};
    if (minPrice !== null) query.price.$gte = minPrice;
    if (maxPrice !== null) query.price.$lte = maxPrice;
  }

  if (minRating !== null) {
    query.rating = { $gte: minRating };
  }

  if (newestDate) {
    query.createdAt = { $gte: newestDate };
  }

  if (andClauses.length > 0) {
    query.$and = andClauses;
  }

  return query;
}

export function buildMarketplaceSort(sortBy) {
  switch (sortBy) {
    case "price_asc":
      return { price: 1, createdAt: -1 };
    case "price_desc":
      return { price: -1, createdAt: -1 };
    case "rating_desc":
      return { rating: -1, createdAt: -1 };
    case "popular":
      return { likes: -1, rating: -1, createdAt: -1 };
    case "newest":
    default:
      return { createdAt: -1 };
  }
}

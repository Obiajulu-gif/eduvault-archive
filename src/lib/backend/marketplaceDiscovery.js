import { ObjectId } from "mongodb";

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

const SEARCH_FIELDS = ["title", "description", "shortSummary", "author", "subject", "category"];
const SEARCH_STOP_WORDS = new Set(["a", "an", "and", "for", "in", "of", "the", "to"]);

export function tokenizeMarketplaceSearch(value) {
  return [...new Set(
    sanitizeString(value, { maxLength: 120 })
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token)),
  )];
}

function fuzzyTokenRegex(token) {
  const variants = [escapeRegExp(token), ...token.split("").map((_, index) => escapeRegExp(token.slice(0, index) + token.slice(index + 1)))];
  for (let index = 0; index < token.length; index += 1) {
    variants.push(`${escapeRegExp(token.slice(0, index))}.${escapeRegExp(token.slice(index + 1))}`);
  }
  return new RegExp(variants.join("|"), "i");
}

export function buildMarketplaceSearchClause(value) {
  const tokens = tokenizeMarketplaceSearch(value);
  if (!tokens.length) return null;

  return {
    $or: SEARCH_FIELDS.map((field) => ({
      [field]: new RegExp(tokens.map(escapeRegExp).join(".*"), "i"),
    })),
    $and: tokens.map((token) => ({
      $or: SEARCH_FIELDS.map((field) => ({ [field]: fuzzyTokenRegex(token) })),
    })),
  };
}

export function buildMarketplaceFacetPipeline(query) {
  const facetFields = ["category", "subject", "level", "language", "fileType"];
  return [
    { $match: query },
    {
      $facet: Object.fromEntries(facetFields.map((field) => [
        field,
        [
          { $match: { [field]: { $nin: [null, ""] } } },
          { $sortByCount: `$${field}` },
          { $limit: 50 },
        ],
      ])),
    },
  ];
}

function normalized(value, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(number, maximum)) / maximum : 0;
}

function textRelevance(item, tokens) {
  if (!tokens.length) return 0;
  const haystack = SEARCH_FIELDS.map((field) => String(item?.[field] ?? "").toLowerCase()).join(" ");
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0) / tokens.length;
}

export function scoreMarketplaceItem(item, search = "", { now = new Date() } = {}) {
  const tokens = tokenizeMarketplaceSearch(search);
  const createdAt = item?.createdAt ? new Date(item.createdAt).getTime() : 0;
  const ageDays = createdAt > 0 ? Math.max(0, (now.getTime() - createdAt) / 86_400_000) : 3650;
  const recency = Math.exp(-ageDays / 180);
  const popularity = Math.min(1, Math.log1p(Math.max(0, Number(item?.likes) || 0)) / Math.log1p(1000));
  const rating = normalized(item?.rating ?? item?.averageScore, 5);
  const completeness = [item?.title, item?.description, item?.shortSummary, item?.thumbnailUrl]
    .filter(Boolean).length / 4;

  // Text is dominant; popularity is deliberately capped and freshness keeps
  // newer quality listings visible instead of creating a permanent popularity loop.
  return (textRelevance(item, tokens) * 0.55)
    + (popularity * 0.15)
    + (recency * 0.15)
    + (rating * 0.1)
    + (completeness * 0.05);
}

export function applyMarketplaceRelevanceRanking(items, search, options = {}) {
  return items
    .map((item, index) => ({ item, index, relevanceScore: scoreMarketplaceItem(item, search, options) }))
    .sort((left, right) => right.relevanceScore - left.relevanceScore || left.index - right.index)
    .map(({ item, relevanceScore }) => ({ ...item, relevanceScore: Number(relevanceScore.toFixed(6)) }));
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

export const LANGUAGE_OPTIONS = [
  { id: "", label: "Any Language" },
  { id: "English", label: "English" },
  { id: "Spanish", label: "Spanish" },
  { id: "French", label: "French" },
  { id: "German", label: "German" },
  { id: "Chinese", label: "Chinese" },
  { id: "Arabic", label: "Arabic" },
  { id: "Portuguese", label: "Portuguese" },
  { id: "Japanese", label: "Japanese" },
];

export function buildMarketplaceDiscoveryQuery(searchParams, { now = new Date() } = {}) {
  const query = {
    visibility: "public",
    archived: { $ne: true },
    moderationStatus: { $ne: "suspended" },
    // Soft-deleted listings stay in the collection so existing purchasers keep
    // their download references, but they must not surface in public results.
    // `$ne: true` rather than `false` so documents predating the field — which
    // have no `isDeleted` at all — still match.
    isDeleted: { $ne: true },
    // Listings by a suspended creator are hidden for the duration of the
    // suspension. Denormalised onto the material so discovery stays a single
    // indexed query instead of a per-result lookup against users.
    creatorSuspended: { $ne: true },
    // Quarantine gate (issue #671): only materials that have passed malware
    // scanning may be listed. Any material with a non-clean quarantine state
    // (pending / rejected / manual_review / timeout / scanner_unavailable) is
    // excluded from the marketplace. Legacy materials created before
    // quarantine tracking existed carry no `quarantineState` field and are
    // kept visible; newly uploaded materials get a state from the scanning
    // pipeline and must be `clean` before they surface.
    $or: [
      { quarantineState: "clean" },
      { quarantineState: { $exists: false } },
    ],
    $and: [
      {
        $or: [
          { relevanceStatus: { $exists: false } },
          { relevanceStatus: { $ne: "low" } },
        ],
      },
    ],
  };
  const andClauses = [];

  const search = sanitizeString(searchParams.get("search"), { maxLength: 120 });
  if (search) {
    const searchClause = buildMarketplaceSearchClause(search);
    if (searchClause) andClauses.push(searchClause);
  }

  const subject = sanitizeString(searchParams.get("subject"), { maxLength: 80 });
  const category = sanitizeString(searchParams.get("category"), { maxLength: 80 });
  const level = sanitizeString(searchParams.get("level"), { maxLength: 80 });
  const language = sanitizeString(searchParams.get("language"), { maxLength: 60 });
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
  if (language) {
    if (language.toLowerCase() === "unknown") {
      andClauses.push({
        $or: [
          { language: { $exists: false } },
          { language: null },
          { language: "" },
          { language: "Unknown" },
        ],
      });
    } else {
      query.language = new RegExp(`^${escapeRegExp(language)}$`, "i");
    }
  }
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

/**
 * Rank a page of search results so materials the buyer already owns sink
 * below ones they don't, while marking every item with `owned` (#707).
 *
 * Product rule: discovery value comes first — a buyer browsing the
 * marketplace is looking for something new, so already-owned materials are
 * demoted rather than removed (a buyer revisiting a listing they own can
 * still find and re-open it, just after the unowned results). The
 * reordering is a stable partition: relative order within "owned" and
 * "not owned" is preserved from the incoming (already DB-sorted) list, so
 * this only reranks within a page and never disturbs the primary sort
 * (price/rating/newest) used to compute pagination cursors.
 *
 * @param {object[]} items - Already-sanitized result documents for one page.
 * @param {Set<string>} ownedIds - Material ids the viewing wallet owns.
 * @returns {object[]} the same items, each with an `owned` boolean, reordered.
 */
export function applyOwnershipRanking(items, ownedIds) {
  const owned = [];
  const notOwned = [];
  for (const item of items) {
    const materialId = String(item?.materialId ?? item?._id ?? "");
    const isOwned = ownedIds.has(materialId);
    const marked = { ...item, owned: isOwned };
    (isOwned ? owned : notOwned).push(marked);
  }
  return [...notOwned, ...owned];
}

export function buildMarketplaceSort(sortBy) {
  switch (sortBy) {
    case "relevance":
      return { createdAt: -1, _id: -1 };
    case "price_asc":
      return { price: 1, createdAt: -1, _id: 1 };
    case "price_desc":
      return { price: -1, createdAt: -1, _id: -1 };
    case "rating_desc":
      return { rating: -1, createdAt: -1, _id: -1 };
    case "popular":
      return { likes: -1, rating: -1, createdAt: -1, _id: -1 };
    case "newest":
    default:
      return { createdAt: -1, _id: -1 };
  }
}

export function encodeMarketplaceCursor(item, sort) {
  const data = { _id: String(item._id) };
  for (const [field] of Object.entries(sort)) {
    if (field !== "_id") data[field] = item[field] instanceof Date ? item[field].toISOString() : item[field];
  }
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

export function decodeMarketplaceCursor(cursor, sort) {
  if (!cursor) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid marketplace cursor");
  }
  if (!data?._id || !ObjectId.isValid(data._id)) throw new Error("Invalid marketplace cursor");
  for (const field of Object.keys(sort)) {
    if (field !== "_id" && data[field] === undefined) throw new Error("Invalid marketplace cursor");
  }
  return data;
}

export function buildMarketplaceCursorClause(cursorData, sort) {
  const fields = Object.entries(sort);
  const clauses = [];
  for (let index = 0; index < fields.length; index += 1) {
    const [field, direction] = fields[index];
    const prefix = {};
    for (let prior = 0; prior < index; prior += 1) {
      const priorField = fields[prior][0];
      prefix[priorField] = priorField === "createdAt" ? new Date(cursorData[priorField]) : (priorField === "_id" ? new ObjectId(cursorData._id) : cursorData[priorField]);
    }
    const value = field === "_id" ? cursorData._id : (field === "createdAt" ? new Date(cursorData[field]) : cursorData[field]);
    prefix[field] = { [direction === 1 ? "$gt" : "$lt"]: field === "_id" ? new ObjectId(value) : value };
    clauses.push(prefix);
  }
  return { $or: clauses };
}

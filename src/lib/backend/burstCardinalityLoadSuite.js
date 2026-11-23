import { applyMarketplaceRelevanceRanking } from './marketplaceDiscovery.js';

/**
 * Burst Traffic & Worst-Case Cardinality Load Testing Suite
 *
 * Provides synthetic high-cardinality dataset generation, adversarial
 * query synthesizers, concurrent burst traffic simulations, latency percentile
 * calculations, exponential backoff with full jitter modeling, and budget assertions.
 *
 * Acceptance Criteria Covered:
 *   - Normal Path: High-cardinality faceted search, cursor traversal & throughput.
 *   - Failure Path: Cardinality explosion, resource exhaustion, and safe rejection.
 *   - Retry Path: Rate limiting (HTTP 429), sliding-window resets, exponential
 *     backoff with jitter, and idempotent retry storm deduplication.
 *   - Authorization Path: High-concurrency mixed-role isolation, field redaction,
 *     tenant isolation, and zero cross-tenant contamination.
 */

export const SUBJECTS_TAXONOMY = [
  'mathematics', 'calculus', 'algebra', 'geometry', 'statistics',
  'physics', 'quantum-mechanics', 'astronomy', 'chemistry', 'organic-chemistry',
  'biology', 'genetics', 'microbiology', 'computer-science', 'algorithms',
  'data-structures', 'cyber-security', 'machine-learning', 'world-history',
  'ancient-civilizations', 'european-history', 'economics', 'microeconomics',
  'macroeconomics', 'literature', 'creative-writing', 'philosophy', 'ethics',
  'psychology', 'sociology',
];

export const CATEGORIES_TAXONOMY = [
  'stem', 'humanities', 'social-sciences', 'languages', 'computer-science',
  'engineering', 'arts', 'business', 'law', 'medicine',
  'environmental-studies', 'education', 'vocational', 'data-science', 'applied-sciences',
];

export const CONTENT_TYPES = ['pdf', 'word', 'presentation', 'spreadsheet', 'text', 'zip'];
export const LICENSE_TYPES = [
  'Standard License (download only)',
  'Creative Commons',
  'Private Use Only',
];
export const LANGUAGES = [
  'English', 'Spanish', 'French', 'German', 'Chinese',
  'Arabic', 'Portuguese', 'Japanese', 'Russian', 'Hindi',
];

/**
 * Calculates latency percentiles (min, max, mean, p50, p90, p95, p99).
 *
 * @param {number[]} latencies - Array of latency measurements in milliseconds
 * @returns {object} Distribution percentiles
 */
export function calculatePercentiles(latencies) {
  if (!latencies || !latencies.length) {
    return { min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, count: 0 };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;

  const getPercentile = (p) => {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
  };

  return {
    count: sorted.length,
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    mean: Number(mean.toFixed(2)),
    p50: Number(getPercentile(50).toFixed(2)),
    p90: Number(getPercentile(90).toFixed(2)),
    p95: Number(getPercentile(95).toFixed(2)),
    p99: Number(getPercentile(99).toFixed(2)),
  };
}

/**
 * Computes exponential backoff with full jitter to avoid thundering herd / retry storms.
 *
 * Formula: sleep = uniform_random(0, min(maxDelayMs, baseDelayMs * 2^attempt))
 *
 * @param {number} attempt - Current retry attempt index (0-indexed)
 * @param {object} [options]
 * @param {number} [options.baseDelayMs=50] - Initial delay in ms
 * @param {number} [options.maxDelayMs=2000] - Cap on delay in ms
 * @param {Function} [options.randomFactor=Math.random] - Random source for test determinism
 * @returns {number} Backoff delay in milliseconds
 */
export function backoffWithJitter(attempt, { baseDelayMs = 50, maxDelayMs = 2000, randomFactor = Math.random } = {}) {
  const boundedAttempt = Math.max(0, Math.min(15, attempt));
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, boundedAttempt));
  return Math.floor(randomFactor() * exponential);
}

/**
 * Generates a synthetic dataset exhibiting worst-case cardinality across facets,
 * nested tags, authors, prices, and timestamps.
 *
 * @param {object} [options]
 * @param {number} [options.size=5000] - Total items to synthesize
 * @param {number} [options.authorCount=500] - Unique creator authors
 * @param {number} [options.tagPoolSize=150] - Pool of distinct search tags
 * @param {Date} [options.now=new Date('2026-06-01T00:00:00.000Z')] - Fixed reference time
 * @returns {Array<object>} Synthesized dataset
 */
export function createWorstCaseCardinalityDataset({
  size = 5000,
  authorCount = 500,
  tagPoolSize = 150,
  now = new Date('2026-06-01T00:00:00.000Z'),
} = {}) {
  const tagPool = Array.from({ length: tagPoolSize }, (_, i) => `tag-keyword-${i}`);

  return Array.from({ length: size }, (_, index) => {
    const subject = SUBJECTS_TAXONOMY[index % SUBJECTS_TAXONOMY.length];
    const category = CATEGORIES_TAXONOMY[index % CATEGORIES_TAXONOMY.length];
    const contentType = CONTENT_TYPES[index % CONTENT_TYPES.length];
    const license = LICENSE_TYPES[index % LICENSE_TYPES.length];
    const language = LANGUAGES[index % LANGUAGES.length];
    const authorId = `creator-${index % authorCount}`;

    // Tag cardinality: 3 to 12 tags per item from pool
    const itemTagCount = 3 + (index % 10);
    const tags = [];
    for (let t = 0; t < itemTagCount; t += 1) {
      tags.push(tagPool[(index * 7 + t * 13) % tagPoolSize]);
    }

    const price = index % 10 === 0 ? 0 : ((index % 50) + 1) * 2.5;
    const rating = 1 + ((index % 40) / 10);
    const likes = (index * 17) % 5000;
    const createdAt = new Date(now.getTime() - index * 45_000).toISOString();

    // Sensitive / authorization-gated fields
    const isQuarantined = index % 200 === 0;
    const isCreatorSuspended = index % 350 === 0;
    const isDeleted = index % 500 === 0;
    const visibility = index % 150 === 0 ? 'private' : 'public';

    return {
      _id: `mat-${index.toString().padStart(6, '0')}`,
      title: `${subject.replace(/-/g, ' ')} comprehensive lecture resource ${index}`,
      description: `In-depth academic module for ${subject} in ${category}. Includes syllabus, practice sets, and detailed solutions. ${tags.join(' ')}`,
      shortSummary: `${subject} guide #${index}`,
      subject,
      category,
      contentType,
      fileType: contentType,
      license,
      language,
      author: authorId,
      ownerAddress: `GDEMO${authorId.replace('-', '').toUpperCase().padEnd(48, '0')}`,
      price,
      rating,
      likes,
      tags,
      createdAt,
      visibility,
      isDeleted,
      creatorSuspended: isCreatorSuspended,
      quarantineStatus: isQuarantined ? 'quarantined' : 'clean',
      moderationStatus: isCreatorSuspended ? 'suspended' : 'approved',
      // Restricted fields that must never leak in PUBLIC responses
      downloadUrl: `https://storage.eduvault.internal/secure/materials/mat-${index}/archive.zip`,
      rawStoragePath: `/var/data/vault/ipfs-blobs/bafy${index}`,
      internalReviewFlags: { flaggedByAdmin: index % 75 === 0, scoreConfidence: 0.98 },
      authorPayoutRoutingKey: `secret-routing-${index}`,
      entitledUsers: [`buyer-${index % 50}`, `buyer-${(index + 3) % 50}`],
    };
  });
}

/**
 * Generates an adversarial stream of high-cardinality search & filter parameter permutations.
 *
 * @param {object} [options]
 * @param {number} [options.count=100] - Total query parameter sets to generate
 * @returns {Array<object>} Query parameters
 */
export function generateWorstCaseQueryCombinations({ count = 100 } = {}) {
  const queries = [];
  const searchTerms = [
    'calculus', 'algebra lecture', 'quantum algorithms', 'genetics organic',
    'ancient civilization', 'ethics data', 'machine learning statistics',
    'microeconomics practice', 'syllabi solutions', 'tag-keyword-12',
  ];

  for (let i = 0; i < count; i += 1) {
    const isAdversarial = i % 15 === 0;
    const isDeepFaceted = i % 2 === 0;

    if (isAdversarial) {
      // Adversarial: long token sequence or oversized values
      queries.push({
        search: `token_${i} `.repeat(15).trim(),
        subject: SUBJECTS_TAXONOMY[i % SUBJECTS_TAXONOMY.length],
        pageSize: 100,
        page: 25,
        sortBy: 'relevance',
      });
    } else if (isDeepFaceted) {
      // Multi-facet conjunction
      queries.push({
        search: searchTerms[i % searchTerms.length],
        subject: SUBJECTS_TAXONOMY[i % SUBJECTS_TAXONOMY.length],
        category: CATEGORIES_TAXONOMY[i % CATEGORIES_TAXONOMY.length],
        contentType: CONTENT_TYPES[i % CONTENT_TYPES.length],
        language: LANGUAGES[i % LANGUAGES.length],
        pageSize: 24,
        sortBy: i % 3 === 0 ? 'relevance' : (i % 3 === 1 ? 'popular' : 'newest'),
      });
    } else {
      // Sparse query with price / rating bounds
      queries.push({
        search: searchTerms[i % searchTerms.length],
        minPrice: 5,
        maxPrice: 50,
        minRating: 3.5,
        pageSize: 12,
        sortBy: 'newest',
      });
    }
  }

  return queries;
}

/**
 * Sanitizes material objects according to authorization role, ensuring zero
 * sensitive data leakage under load.
 *
 * @param {object} item - Material object
 * @param {string} role - Authorization role ('PUBLIC', 'BUYER', 'CREATOR', 'OPERATOR_ADMIN')
 * @param {object} [context]
 * @param {string} [context.userAddress] - Viewing user address or ID
 * @returns {object} Redacted material object
 */
export function sanitizeMaterialForRole(item, role = 'PUBLIC', context = {}) {
  if (!item) return null;

  const publicSafe = {
    _id: item._id,
    title: item.title,
    description: item.description,
    shortSummary: item.shortSummary,
    subject: item.subject,
    category: item.category,
    contentType: item.contentType,
    fileType: item.fileType,
    license: item.license,
    language: item.language,
    author: item.author,
    price: item.price,
    rating: item.rating,
    likes: item.likes,
    tags: item.tags,
    createdAt: item.createdAt,
    visibility: item.visibility,
  };

  if (role === 'OPERATOR_ADMIN') {
    return {
      ...item,
      _sanitizationScope: 'OPERATOR_ADMIN',
    };
  }

  if (role === 'CREATOR' && context.userAddress === item.author) {
    return {
      ...publicSafe,
      rawStoragePath: item.rawStoragePath,
      internalReviewFlags: item.internalReviewFlags,
      moderationStatus: item.moderationStatus,
      quarantineStatus: item.quarantineStatus,
      _sanitizationScope: 'CREATOR',
    };
  }

  if (role === 'BUYER' && Array.isArray(item.entitledUsers) && item.entitledUsers.includes(context.userAddress)) {
    return {
      ...publicSafe,
      downloadUrl: item.downloadUrl,
      _sanitizationScope: 'BUYER',
    };
  }

  // PUBLIC fallback: strict suppression of all credentials, raw paths, internal flags
  return {
    ...publicSafe,
    _sanitizationScope: 'PUBLIC',
  };
}

/**
 * Bounded in-memory sliding window rate limiter with LRU eviction protection
 * against cardinality explosion attacks.
 */
export function createBoundedRateLimiter({ limit = 60, windowMs = 60_000, maxBuckets = 5000 } = {}) {
  const buckets = new Map();

  return {
    check(key, now = Date.now()) {
      const bucketKey = String(key || 'anonymous');
      const windowStart = now - windowMs;

      // LRU / capacity eviction if map exceeds safety cardinality ceiling
      if (buckets.size >= maxBuckets && !buckets.has(bucketKey)) {
        const oldestKey = buckets.keys().next().value;
        buckets.delete(oldestKey);
      }

      let timestamps = buckets.get(bucketKey) || [];
      timestamps = timestamps.filter((ts) => ts > windowStart);

      if (timestamps.length < limit) {
        timestamps.push(now);
        buckets.set(bucketKey, timestamps);
        const resetAt = timestamps[0] + windowMs;
        return {
          allowed: true,
          remaining: limit - timestamps.length,
          resetAt,
          retryAfter: 0,
        };
      }

      const resetAt = timestamps[0] + windowMs;
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      };
    },
    reset() {
      buckets.clear();
    },
    size() {
      return buckets.size;
    },
  };
}

/**
 * Simulates concurrent burst traffic against an async handler with concurrency pool.
 *
 * @param {object} options
 * @param {Array<object>} options.requests - Workload requests
 * @param {number} [options.concurrency=20] - Max concurrent fibers
 * @param {Function} options.handler - Async function processing each request
 * @returns {Promise<object>} Complete metrics report
 */
export async function simulateBurstTraffic({
  requests,
  concurrency = 20,
  handler,
}) {
  if (!requests || !requests.length) {
    throw new Error('Requests array must not be empty');
  }

  if (global.gc) global.gc();
  const heapStart = process.memoryUsage().heapUsed;
  const startedAt = performance.now();

  const latencies = [];
  const statusBreakdown = {
    200: 0,
    400: 0,
    401: 0,
    403: 0,
    429: 0,
    500: 0,
    503: 0,
    other: 0,
  };
  const errors = [];

  let requestIndex = 0;
  const total = requests.length;

  async function worker() {
    while (requestIndex < total) {
      const currentIndex = requestIndex;
      requestIndex += 1;
      const req = requests[currentIndex];

      const itemStart = performance.now();
      try {
        const res = await handler(req, currentIndex);
        const itemElapsed = performance.now() - itemStart;
        latencies.push(itemElapsed);

        const status = res?.status || (res?.allowed === false ? 429 : 200);
        if (status in statusBreakdown) {
          statusBreakdown[status] += 1;
        } else {
          statusBreakdown.other += 1;
        }
      } catch (err) {
        const itemElapsed = performance.now() - itemStart;
        latencies.push(itemElapsed);
        statusBreakdown[500] += 1;
        errors.push({ index: currentIndex, error: err.message });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(workers);

  const durationMs = performance.now() - startedAt;
  const heapEnd = process.memoryUsage().heapUsed;
  const heapDeltaMb = Number(((heapEnd - heapStart) / (1024 * 1024)).toFixed(2));
  const rps = Number(((total / (durationMs / 1000))).toFixed(2));

  return {
    totalRequests: total,
    concurrency,
    durationMs: Number(durationMs.toFixed(2)),
    rps,
    statusBreakdown,
    latencies: calculatePercentiles(latencies),
    memory: {
      heapStartMb: Number((heapStart / (1024 * 1024)).toFixed(2)),
      heapEndMb: Number((heapEnd / (1024 * 1024)).toFixed(2)),
      heapDeltaMb,
    },
    errors,
  };
}

/**
 * Asserts load test metrics against acceptable budget thresholds.
 *
 * @param {object} metrics - Result from simulateBurstTraffic
 * @param {object} budgets - Ceiling specifications
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function assertBurstLoadBudgets(metrics, budgets = {}) {
  const violations = [];
  const {
    maxP95Ms = 250,
    maxP99Ms = 500,
    minRps = 100,
    maxHeapDeltaMb = 60,
    maxErrorRatePercent = 0,
    expectedMin200RatePercent = null,
  } = budgets;

  if (metrics.latencies.p95 > maxP95Ms) {
    violations.push(`p95 latency (${metrics.latencies.p95}ms) exceeded ceiling of ${maxP95Ms}ms`);
  }

  if (metrics.latencies.p99 > maxP99Ms) {
    violations.push(`p99 latency (${metrics.latencies.p99}ms) exceeded ceiling of ${maxP99Ms}ms`);
  }

  if (metrics.rps < minRps) {
    violations.push(`Throughput (${metrics.rps} req/s) fell below floor of ${minRps} req/s`);
  }

  if (metrics.memory.heapDeltaMb > maxHeapDeltaMb) {
    violations.push(`Heap growth (${metrics.memory.heapDeltaMb}MB) exceeded ceiling of ${maxHeapDeltaMb}MB`);
  }

  const totalErrors = metrics.errors.length + (metrics.statusBreakdown[500] || 0);
  const errorRatePercent = (totalErrors / metrics.totalRequests) * 100;
  if (errorRatePercent > maxErrorRatePercent) {
    violations.push(`Error rate (${errorRatePercent.toFixed(1)}%) exceeded allowable max of ${maxErrorRatePercent}%`);
  }

  if (expectedMin200RatePercent !== null) {
    const success200Rate = ((metrics.statusBreakdown[200] || 0) / metrics.totalRequests) * 100;
    if (success200Rate < expectedMin200RatePercent) {
      violations.push(`200 OK rate (${success200Rate.toFixed(1)}%) fell below expected ${expectedMin200RatePercent}%`);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    metrics,
  };
}

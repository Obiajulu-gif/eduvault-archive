/**
 * Deterministic sorting contract for mixed-status record lists (Issue #887).
 *
 * Sort precedence:
 *   1. Status precedence (active records first, deleted last)
 *   2. Timestamp (newest first by default)
 *   3. Tie-breaker: record ID (ascending, lexicographic)
 *
 * This contract ensures list ordering is stable across repeated queries,
 * pagination, and UI renders — even when timestamps are identical.
 */

export const STATUS_PRECEDENCE = {
  // Active / live records
  published: 0,
  active: 0,
  settled: 0,
  completed: 0,
  // In-progress records
  pending: 1,
  draft: 1,
  requested: 1,
  approved: 1,
  submitting: 1,
  investigating: 1,
  pending_approval: 1,
  // Restricted records
  suspended: 2,
  quarantined: 2,
  appealed: 2,
  // Terminal / retired records
  archived: 3,
  rejected: 3,
  failed: 3,
  denied: 3,
  closed: 3,
  // Soft-deleted always sorts last
  deleted: 4,
};

const DEFAULT_PRECEDENCE = 5;

function getStatusPrecedence(record) {
  // Soft-deleted records always sort last regardless of other status fields
  if (record.isDeleted) return STATUS_PRECEDENCE.deleted;

  const status = record.status || record.moderationStatus || record.visibility;
  if (!status) return DEFAULT_PRECEDENCE;
  return STATUS_PRECEDENCE[status] ?? DEFAULT_PRECEDENCE;
}

function getTimestamp(record, field) {
  const value = record[field];
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function getTieBreaker(record) {
  const id = record._id ?? record.id ?? "";
  return String(id);
}

/**
 * Sorts records deterministically by status precedence, timestamp, and ID.
 *
 * @param {Array} records - Records to sort
 * @param {object} [options]
 * @param {string} [options.timestampField='createdAt'] - Field to sort by
 * @param {boolean} [options.descending=true] - Newest first when true
 * @param {object} [options.statusPrecedence] - Custom status precedence map
 * @returns {Array} New sorted array (does not mutate input)
 */
export function sortRecords(records, { timestampField = "createdAt", descending = true, statusPrecedence } = {}) {
  if (!Array.isArray(records) || records.length <= 1) return [...(records || [])];

  const precedenceMap = statusPrecedence || STATUS_PRECEDENCE;
  const direction = descending ? -1 : 1;

  return [...records].sort((a, b) => {
    // 1. Status precedence
    const aDeleted = a.isDeleted ? STATUS_PRECEDENCE.deleted : null;
    const bDeleted = b.isDeleted ? STATUS_PRECEDENCE.deleted : null;
    const aStatus = aDeleted ?? (precedenceMap[a.status || a.moderationStatus || a.visibility] ?? DEFAULT_PRECEDENCE);
    const bStatus = bDeleted ?? (precedenceMap[b.status || b.moderationStatus || b.visibility] ?? DEFAULT_PRECEDENCE);
    if (aStatus !== bStatus) return aStatus - bStatus;

    // 2. Timestamp (newest first by default)
    const aTime = getTimestamp(a, timestampField);
    const bTime = getTimestamp(b, timestampField);
    if (aTime !== bTime) return (aTime - bTime) * direction;

    // 3. Tie-breaker: ID (always ascending for determinism)
    const aId = getTieBreaker(a);
    const bId = getTieBreaker(b);
    if (aId < bId) return -1;
    if (aId > bId) return 1;
    return 0;
  });
}

/**
 * Paginates a sorted record list. Sorting is applied before pagination so
 * page boundaries are stable across repeated queries.
 *
 * @param {Array} records - Records to paginate
 * @param {object} [options]
 * @param {number} [options.page=1] - 1-indexed page number
 * @param {number} [options.pageSize=12] - Items per page
 * @param {object} [options.sortOptions] - Passed to sortRecords
 * @returns {{items: Array, page: number, pageSize: number, total: number, totalPages: number}}
 */
export function paginateRecords(records, { page = 1, pageSize = 12, sortOptions } = {}) {
  const sorted = sortRecords(records, sortOptions);
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const start = (currentPage - 1) * pageSize;
  return {
    items: sorted.slice(start, start + pageSize),
    page: currentPage,
    pageSize,
    total,
    totalPages,
  };
}

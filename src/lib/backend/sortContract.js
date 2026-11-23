/**
 * Deterministic sorting contract for mixed-status records and events
 * (Issue #887, extended for events and resumable paging #1141).
 *
 * Records (sortRecords):
 *   1. Status precedence (active records first, deleted last)
 *   2. Timestamp (newest first by default); missing/invalid timestamps last
 *   3. Tie-breaker: record ID (ascending, code-unit order)
 *
 * Events (sortEvents), oldest first by default so a timeline reads in order:
 *   1. Timestamp; missing/invalid timestamps last
 *   2. Sequence number (events from one source carry a monotonic `sequence`)
 *   3. Lifecycle rank of the status (requested < in progress < terminal < compensating)
 *   4. Tie-breaker: event ID (ascending, code-unit order)
 *
 * The same set of items always produces the same order, whatever order the
 * database or a retry returned them in. Ordering depends only on the items
 * themselves, so a viewer's permission filter can never change the relative
 * order of the items they can see. See docs/deterministic-sorting.md.
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

/**
 * Position of an event status within one operation's lifecycle. Used only to
 * order events that share a timestamp and sequence.
 */
export const EVENT_STATUS_RANK = {
  // Started
  requested: 0,
  created: 0,
  queued: 0,
  pending: 0,
  initiated: 0,
  // In flight
  processing: 1,
  in_progress: 1,
  submitting: 1,
  retrying: 1,
  accepting: 1,
  // Terminal outcome
  succeeded: 2,
  completed: 2,
  settled: 2,
  applied: 2,
  published: 2,
  accepted: 2,
  failed: 2,
  rejected: 2,
  denied: 2,
  declined: 2,
  cancelled: 2,
  expired: 2,
  // After a terminal outcome: undoing or correcting it
  rolled_back: 3,
  reverted: 3,
  refunded: 3,
  compensated: 3,
};

const DEFAULT_EVENT_RANK = 4;
const EVENT_TIMESTAMP_FIELDS = ["occurredAt", "timestamp", "createdAt", "at"];

const hasOwn = (map, key) => Object.prototype.hasOwnProperty.call(map, key);

/** Case/whitespace-insensitive lookup that ignores inherited keys such as "constructor". */
function lookupRank(map, rawStatus, fallback) {
  if (rawStatus === undefined || rawStatus === null || rawStatus === "") return fallback;
  const raw = String(rawStatus);
  if (hasOwn(map, raw)) return map[raw];
  const normalized = raw.trim().toLowerCase();
  return hasOwn(map, normalized) ? map[normalized] : fallback;
}

/** Epoch milliseconds, or null when the value is absent or not a usable time. */
function parseTime(value) {
  let time = null;
  if (value instanceof Date) time = value.getTime();
  else if (typeof value === "number") time = value;
  else if (typeof value === "string" && value.trim()) time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function idOf(item) {
  return String(item._id ?? item.id ?? item.eventId ?? item.failureId ?? "");
}

function compareIds(a, b) {
  const aId = idOf(a);
  const bId = idOf(b);
  if (aId < bId) return -1;
  if (aId > bId) return 1;
  return 0;
}

/** Compare two nullable numbers: values by `direction`, missing always after present. */
function compareNullable(a, b, direction) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a === b ? 0 : (a < b ? -1 : 1) * direction;
}

const orEmpty = (item) => (item !== null && typeof item === "object" ? item : {});

function recordPrecedence(record, map) {
  // Soft-deleted always sorts last regardless of other status fields
  if (record.isDeleted) return STATUS_PRECEDENCE.deleted;
  return lookupRank(map, record.status || record.moderationStatus || record.visibility, DEFAULT_PRECEDENCE);
}

/** Comparator implementing the record contract. */
export function createRecordComparator({ timestampField = "createdAt", descending = true, statusPrecedence } = {}) {
  const map = statusPrecedence || STATUS_PRECEDENCE;
  const direction = descending ? -1 : 1;
  return (left, right) => {
    const a = orEmpty(left);
    const b = orEmpty(right);
    return (
      recordPrecedence(a, map) - recordPrecedence(b, map) ||
      compareNullable(parseTime(a[timestampField]), parseTime(b[timestampField]), direction) ||
      compareIds(a, b)
    );
  };
}

function eventTime(event, timestampField) {
  if (timestampField) return parseTime(event[timestampField]);
  for (const field of EVENT_TIMESTAMP_FIELDS) {
    const time = parseTime(event[field]);
    if (time !== null) return time;
  }
  return null;
}

function eventSequence(event) {
  const value = typeof event.sequence === "string" && event.sequence.trim() ? Number(event.sequence) : event.sequence;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Comparator implementing the event contract. */
export function createEventComparator({ timestampField, descending = false, statusRank } = {}) {
  const map = statusRank || EVENT_STATUS_RANK;
  const direction = descending ? -1 : 1;
  const rank = (event) => lookupRank(map, event.status ?? event.state ?? event.outcome, DEFAULT_EVENT_RANK);
  return (left, right) => {
    const a = orEmpty(left);
    const b = orEmpty(right);
    return (
      compareNullable(eventTime(a, timestampField), eventTime(b, timestampField), direction) ||
      compareNullable(eventSequence(a), eventSequence(b), direction) ||
      (rank(a) - rank(b)) * direction ||
      compareIds(a, b)
    );
  };
}

function sortWith(items, comparator) {
  return Array.isArray(items) ? [...items].sort(comparator) : [];
}

/**
 * Sorts records deterministically by status precedence, timestamp, and ID.
 *
 * @param {Array} records - Records to sort
 * @param {object} [options]
 * @param {string} [options.timestampField='createdAt'] - Field to sort by
 * @param {boolean} [options.descending=true] - Newest first when true
 * @param {object} [options.statusPrecedence] - Custom status precedence map
 * @param {(record: object) => boolean} [options.isVisible] - Authorization filter, applied before sorting
 * @returns {Array} New sorted array (does not mutate input)
 */
export function sortRecords(records, options = {}) {
  const visible = typeof options.isVisible === "function" && Array.isArray(records) ? records.filter(options.isVisible) : records;
  return sortWith(visible, createRecordComparator(options));
}

/**
 * Sorts events deterministically by time, sequence, lifecycle rank, and ID.
 *
 * @param {Array} events - Events to sort
 * @param {object} [options]
 * @param {string} [options.timestampField] - Field to sort by; default is the first present of occurredAt, timestamp, createdAt, at
 * @param {boolean} [options.descending=false] - Newest first when true
 * @param {object} [options.statusRank] - Custom lifecycle rank map
 * @param {(event: object) => boolean} [options.isVisible] - Authorization filter, applied before sorting
 * @returns {Array} New sorted array (does not mutate input)
 */
export function sortEvents(events, options = {}) {
  const visible = typeof options.isVisible === "function" && Array.isArray(events) ? events.filter(options.isVisible) : events;
  return sortWith(visible, createEventComparator(options));
}

function comparatorFor(kind, options) {
  if (kind === "events") return createEventComparator(options);
  if (kind === "records") return createRecordComparator(options);
  throw new TypeError(`Unknown sort kind: ${kind}`);
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
 * @param {(record: object) => boolean} [options.isVisible] - Authorization filter, applied before sorting and counting
 * @returns {{items: Array, page: number, pageSize: number, total: number, totalPages: number}}
 */
export function paginateRecords(records, { page = 1, pageSize = 12, sortOptions, isVisible } = {}) {
  const visible = typeof isVisible === "function" && Array.isArray(records) ? records.filter(isVisible) : records;
  const sorted = sortRecords(visible, sortOptions);
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

/**
 * Keyset paging: the items strictly after `after` in contract order.
 *
 * Unlike page numbers, resuming from the last item seen is unaffected by items
 * inserted or removed earlier in the list, so a client that retries after a
 * failure neither skips nor repeats items. `after` need only carry the fields
 * the contract sorts on (status, timestamp, sequence, id).
 *
 * @param {Array} items
 * @param {object} [options]
 * @param {'records'|'events'} [options.kind='records']
 * @param {object|null} [options.after] - Last item of the previous page
 * @param {number} [options.limit=12]
 * @param {object} [options.sortOptions]
 * @param {(item: object) => boolean} [options.isVisible] - Authorization filter, applied first
 * @returns {{items: Array, nextAfter: object|null, hasMore: boolean}}
 */
export function pageAfter(items, { kind = "records", after = null, limit = 12, sortOptions, isVisible } = {}) {
  const comparator = comparatorFor(kind, sortOptions);
  const visible = typeof isVisible === "function" && Array.isArray(items) ? items.filter(isVisible) : items;
  const sorted = sortWith(visible, comparator);
  const startIndex = after === null || after === undefined ? 0 : sorted.findIndex((item) => comparator(item, after) > 0);
  const remaining = startIndex === -1 ? [] : sorted.slice(startIndex);
  const pageItems = remaining.slice(0, Math.max(1, limit));
  return {
    items: pageItems,
    nextAfter: pageItems.length ? pageItems[pageItems.length - 1] : null,
    hasMore: remaining.length > pageItems.length,
  };
}

/**
 * Executable check for a list claimed to follow the contract. Reports items
 * that are out of order and IDs that appear more than once (identical keys
 * cannot be ordered deterministically, so duplicates are a data bug to fix).
 *
 * @returns {{ok: boolean, outOfOrder: number[], duplicateIds: string[]}}
 */
export function verifyOrdering(items, { kind = "records", sortOptions } = {}) {
  const comparator = comparatorFor(kind, sortOptions);
  const list = Array.isArray(items) ? items : [];
  const outOfOrder = [];
  const seen = new Set();
  const duplicates = new Set();
  list.forEach((item, index) => {
    if (index > 0 && comparator(list[index - 1], item) > 0) outOfOrder.push(index);
    const id = idOf(orEmpty(item));
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  });
  return { ok: outOfOrder.length === 0 && duplicates.size === 0, outOfOrder, duplicateIds: [...duplicates] };
}

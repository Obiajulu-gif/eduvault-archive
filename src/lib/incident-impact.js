/**
 * Incident impact calculator for EduVault.
 *
 * Given a set of incident signals (records, operations, time window),
 * aggregate the affected users, records, operations and severity into a
 * deterministic impact report. The report is split into an internal
 * view (full detail for maintainers) and a shareable view that redacts
 * sensitive identifiers and free-form details.
 *
 * The module is pure and deterministic: no I/O, no clock reads,
 * no randomness. All ordering is stable and all collections are
 * deduplicated before being returned.
 */

const SEVERITY_ORDER = ["none", "low", "medium", "high", "critical"];

const SEVERITY_WEIGHT = {
  none: 0,
  low: 1,
  medium: 2,
 high: 3,
  critical: 4,
};

/**
 * Operations that are considered sensitive and therefore raise the
 * base severity of an incident when they appear in the affected set.
 */
const SENSITIVE_OPERATIONS = new Set([
  "download",
  "purchase",
  "refund",
  "settlement",
  "wallet_auth",
  "entitlement_grant",
]);

/**
 * Normalize an arbitrary value into an array of non-empty strings.
 */
function toStringArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : String(v)))
      .filter((v) => v.length > 0);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [String(value)];
}

/**
 * Dedupe and sort an array of strings deterministically.
 */
function uniqueSorted(values) {
  return Array.from(new Set(values)).sort();
}

/**
 * Parse a timestamp into milliseconds. Accepts Date instances, numeric
 * epoch values, and ISO strings. Returns null when the value cannot be
 * interpreted.
 */
function parseTimestamp(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Return the higher of two severity labels.
 */
function maxSeverity(left, right) {
  const leftWeight = SEVERITY_WEIGHT[left] ?? 0;
  const rightWeight = SEVERITY_WEIGHT[right] ?? 0;
  return leftWeight >= rightWeight ? left : right;
}

/**
 * Normalize an incident input into a consistent shape.
 */
function normalizeInput(input) {
  const src = input && typeof input === "object" ? input : {};
  const window = src.window && typeof src.window === "object" ? src.window : {};
  return {
    incidentId: typeof src.incidentId === "string" ? src.incidentId : null,
    title: typeof src.title === "string" ? src.title : null,
    severity: SEVERITY_ORDER.includes(src.severity) ? src.severity : "none",
    window: {
      from: parseTimestamp(window.from),
      to: parseTimestamp(window.to),
    },
    affectedUsers: toStringArray(src.affectedUsers),
    affectedRecords: toStringArray(src.affectedRecords),
    affectedOperations: toStringArray(src.affectedOperations),
    events: Array.isArray(src.events) ? src.events : [],
  };
}

/**
 * Determine whether a timestamp falls within the configured window.
 * A missing bound is treated as open on that side.
 */
function inWindow(timestamp, window) {
  if (timestamp == null) return true;
  if (window.from != null && timestamp < window.from) return false;
  if (window.to != null && timestamp > window.to) return false;
  return true;
}

/**
 * Extract the affected identifiers from a single event record.
 */
function eventContributions(event) {
  if (!event || typeof event !== "object") {
    return { users: [], records: [], operations: [], severity: "none" };
  }
  const users = toStringArray(event.users).concat(toStringArray(event.userId));
  const records = toStringArray(event.records).concat(toStringArray(event.recordId));
  const operations = toStringArray(event.operations).concat(toStringArray(event.operation));
  const severity = SEVERITY_ORDER.includes(event.severity) ? event.severity : "none";
  return { users, records, operations, severity };
}

/**
 * Redact a string identifier for shareable output. Keeps a stable,
 * non-reversible prefix so maintainers can correlate reports without
 * exposing the original value.
 */
function redactIdentifier(value) {
  if (typeof value !== "string" || value.length === 0) return "redacted";
  const prefix = value.slice(0, 4);
  return `${prefix}…redacted`;
}

/**
 * Build the internal and shareable impact report from normalized input.
 */
function buildReport(normalized) {
  const users = new Set(normalized.affectedUsers);
  const records = new Set(normalized.affectedRecords);
  const operations = new Set(normalized.affectedOperations);
  let severity = normalized.severity;

  const events = [];
  for (const rawEvent of normalized.events) {
    const timestamp = parseTimestamp(rawEvent && rawEvent.timestamp);
    if (!inWindow(timestamp, normalized.window)) continue;
    const contribution = eventContributions(rawEvent);
    for (const u of contribution.users) users.add(u);
    for (const r of contribution.records) records.add(r);
    for (const o of contribution.operations) operations.add(o);
    severity = maxSeverity(severity, contribution.severity);
    events.push({
      id: typeof rawEvent.id === "string" ? rawEvent.id : null,
      timestamp,
      severity: contribution.severity,
      users: uniqueSorted(contribution.users),
      records: uniqueSorted(contribution.records),
      operations: uniqueSorted(contribution.operations),
    });
  }

  // Sensitive operations raise the floor severity even if the events
  // themselves were labeled lower.
  for (const op of operations) {
    if (SENSITIVE_OPERATIONS.has(op)) {
      severity = maxSeverity(severity, "high");
    }
  }

  const userList = uniqueSorted(Array.from(users));
  const recordList = uniqueSorted(Array.from(records));
  const operationList = uniqueSorted(Array.from(operations));

  const internal = {
    incidentId: normalized.incidentId,
    title: normalized.title,
    severity,
    window: {
      from: normalized.window.from == null ? null : new Date(normalized.window.from).toISOString(),
      to: normalized.window.to == null ? null : new Date(normalized.window.to).toISOString(),
    },
    counts: {
      users: userList.length,
      records: recordList.length,
      operations: operationList.length,
      events: events.length,
    },
    affectedUsers: userList,
    affectedRecords: recordList,
    affectedOperations: operationList,
    events,
  };

  const shareable = {
    incidentId: redactIdentifier(normalized.incidentId),
    severity,
    window: internal.window,
    counts: internal.counts,
    affectedUsers: userList.map(redactIdentifier),
    affectedRecords: recordList.map(redactIdentifier),
    affectedOperations: operationList,
  };

  return { internal, shareable };
}

/**
 * Calculate the impact of an incident.
 *
 * @param {Object} input
 * @param {string} [input.incidentId]
 * @param {string} [input.title]
 * @param {"string"} [input.severity]
 * @param {{}} [input.window]
 * @param {string[]} [input.affectedUsers]
 * @param {string[]} [input.affectedRecords]
 * @param {string[]} [input.affectedOperations]
 * @param {Object[]} [input.events]
 * @returns {{internal: Object, shareable: Object}}
 */
function calculateIncidentImpact(input) {
  const normalized = normalizeInput(input);
  return buildReport(normalized);
}

export {
  calculateIncidentImpact,
  redactIdentifier,
  SEVERITY_ORDER,
};

export default calculateIncidentImpact;

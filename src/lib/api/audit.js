import { getContext } from "../telemetry/context.js";
import { redactFields } from "../telemetry/redact.js";

// Audit logs are deliberately allow-listed: unlike application logs, these
// records are retained for investigations and must never accidentally include
// request bodies, credentials, or raw uploaded content.
const SAFE_FIELDS = new Set([
  "event",
  "route",
  "method",
  "status",
  "reason",
  "actor",
  "walletAddress",
  "materialId",
  "cursor",
  "eventId",
  "outcome",
  "action",
  "resource",
  "uploadId",
  "source",
  "network",
  "ledger",
  "durationMs",
  "retryCount",
  "errorCode",
]);

export function createAuditEntry(fields = {}) {
  const context = getContext();
  const entry = {
    timestamp: new Date().toISOString(),
    correlationId: context?.correlationId,
    traceId: context?.traceId,
    route: context?.route,
    jobType: context?.jobType,
  };

  for (const [key, value] of Object.entries(redactFields(fields))) {
    if (SAFE_FIELDS.has(key) && value !== undefined && value !== null) {
      entry[key] = String(value).slice(0, 300);
    }
  }

  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined && value !== null));
}

export function auditLog(fields) {
  const entry = createAuditEntry(fields);
  console.info(JSON.stringify(entry));
  return entry;
}

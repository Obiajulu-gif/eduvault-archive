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
  "caseId",
  "proposerId",
  "approverId",
  "sanction",
  "creatorId",
  "decision",
  "reviewerId",
]);

export function auditLog(fields) {
  const entry = { timestamp: new Date().toISOString() };

  for (const [key, value] of Object.entries(fields || {})) {
    if (SAFE_FIELDS.has(key) && value !== undefined && value !== null) {
      entry[key] = String(value).slice(0, 300);
    }
  }

  console.info(JSON.stringify(entry));
}

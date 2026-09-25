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
  "refundId",
  "purchaseId",
  "correlationId",
  "policyVersion",
  "role",
  "material",
  "version",
  "purchase"
]);

export function auditLog(fields) {
  const entry = { timestamp: new Date().toISOString() };

  for (const [key, value] of Object.entries(fields || {})) {
    if (SAFE_FIELDS.has(key) && value !== undefined && value !== null) {
      let stringValue = String(value);
      stringValue = stringValue.replace(/(bearer\s+)[^\s]+/ig, '$1***');
      stringValue = stringValue.replace(/(token=)[^\s&]+/ig, '$1***');
      stringValue = stringValue.replace(/https?:\/\/[^\s]+/ig, '***');
      entry[key] = stringValue.slice(0, 300);
    }
  }

  console.info(JSON.stringify(entry));
}

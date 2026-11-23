import crypto from "node:crypto";
import { hasPermission } from "../auth/permissions.js";
import { canonicalize } from "../backend/auditLedger.js";
import { maskEmail, maskWalletAddress, pseudonymize } from "../learner-export/fieldAuthorization.js";

export const EXPORT_SCHEMA_VERSION = "1.0.0";
export const REDACTED_VALUE = "[REDACTED]";

export const RedactionAction = Object.freeze({
  ALLOW: "allow",
  REDACT: "redact",
  MASK: "mask",
  HASH: "hash",
});

const SECRET_KEY_PATTERN = /(password|secret|token|credential|private.?key|seed|authorization|cookie)/i;

export class PermissionExportError extends Error {
  constructor(message, { code = "AUTH_FORBIDDEN", status = 403, retryable = false, attempts = 1 } = {}) {
    super(message);
    this.name = "PermissionExportError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.attempts = attempts;
  }
}

function maskGenericString(value) {
  const str = String(value);
  if (str.includes("@")) return maskEmail(str);
  if (str.length > 20 && /^[A-Z0-9]+$/i.test(str)) return maskWalletAddress(str);
  if (str.length <= 2) return "***";
  return `${str[0]}***${str[str.length - 1]}`;
}

function resolveAction(policyEntry, actor) {
  if (!policyEntry) return RedactionAction.ALLOW;
  return typeof policyEntry === "function" ? policyEntry(actor) : policyEntry;
}

function transformField(value, path, action, tracker) {
  if (action === RedactionAction.REDACT) {
    tracker.redacted.add(path);
    return REDACTED_VALUE;
  }
  if (action === RedactionAction.MASK && value != null) {
    tracker.masked.add(path);
    return maskGenericString(value);
  }
  if (action === RedactionAction.HASH && value != null) {
    tracker.hashed.add(path);
    return `pseudo_${pseudonymize(value)}`;
  }
  return value;
}

function redactNode(value, path, fieldPolicies, actor, tracker) {
  if (path && SECRET_KEY_PATTERN.test(path.split(".").pop() || "")) {
    tracker.redacted.add(path);
    return REDACTED_VALUE;
  }

  if (path && Object.hasOwn(fieldPolicies, path)) {
    const action = resolveAction(fieldPolicies[path], actor);
    if (action !== RedactionAction.ALLOW) {
      return transformField(value, path, action, tracker);
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactNode(item, path, fieldPolicies, actor, tracker));
  }

  if (value && typeof value === "object" && !(value instanceof Date)) {
    const sortedEntries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(
      sortedEntries.map(([key, item]) => {
        const nextPath = path ? `${path}.${key}` : key;
        return [key, redactNode(item, nextPath, fieldPolicies, actor, tracker)];
      }),
    );
  }

  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Redacts a single record according to `fieldPolicies` and the caller's permissions.
 */
export function redactRecordForActor(record, { actor, fieldPolicies = {} } = {}) {
  const tracker = { redacted: new Set(), masked: new Set(), hashed: new Set() };
  const redacted = redactNode(record, "", fieldPolicies, actor, tracker);
  return {
    record: redacted,
    redactedFields: [...tracker.redacted].sort(),
    maskedFields: [...tracker.masked].sort(),
    hashedFields: [...tracker.hashed].sort(),
  };
}

/**
 * Executes a permission-aware export with field-level redaction and bounded retries
 * on transient fetch failures. Authorization is enforced before any data is fetched.
 */
export async function executePermissionAwareExport({
  actor = null,
  requiredPermission = "creator:analytics:read",
  authorize = null,
  records = null,
  fetchRecords = null,
  fieldPolicies = {},
  maxRetries = 2,
  purpose = "general_export",
  generatedAt = new Date(),
} = {}) {
  if (!actor) {
    throw new PermissionExportError("Authentication required for export.", {
      code: "AUTH_UNAUTHENTICATED",
      status: 401,
      retryable: false,
    });
  }

  const permitted = typeof authorize === "function"
    ? (await authorize(actor, requiredPermission)) === true
    : hasPermission(actor, requiredPermission);

  if (!permitted) {
    throw new PermissionExportError(`Missing required permission: ${requiredPermission}`, {
      code: "AUTH_FORBIDDEN",
      status: 403,
      retryable: false,
    });
  }

  let sourceRecords = records;
  let attempts = 0;

  if (typeof fetchRecords === "function") {
    while (true) {
      attempts += 1;
      try {
        sourceRecords = await fetchRecords({ attempt: attempts });
        break;
      } catch (err) {
        const retryable = err?.retryable === true;
        if (!retryable || attempts > maxRetries) {
          throw new PermissionExportError(err?.message || "Export source failed.", {
            code: err?.code || (retryable ? "STORAGE_UNAVAILABLE" : "VALIDATION_FAILED"),
            status: err?.status || (retryable ? 503 : 500),
            retryable,
            attempts,
          });
        }
      }
    }
  } else {
    attempts = 1;
  }

  if (!Array.isArray(sourceRecords)) {
    throw new PermissionExportError("records must be an array", {
      code: "VALIDATION_FAILED",
      status: 400,
      retryable: false,
      attempts,
    });
  }

  const generated = new Date(generatedAt);
  if (Number.isNaN(generated.getTime())) {
    throw new PermissionExportError("generatedAt must be a valid date", {
      code: "VALIDATION_FAILED",
      status: 400,
      retryable: false,
      attempts,
    });
  }

  const allRedacted = new Set();
  const allMasked = new Set();
  const allHashed = new Set();

  const exportedRecords = sourceRecords.map((rec) => {
    const res = redactRecordForActor(rec, { actor, fieldPolicies });
    res.redactedFields.forEach((f) => allRedacted.add(f));
    res.maskedFields.forEach((f) => allMasked.add(f));
    res.hashedFields.forEach((f) => allHashed.add(f));
    return res.record;
  });

  const contentHash = crypto.createHash("sha256").update(canonicalize(exportedRecords)).digest("hex");
  const exportId = crypto
    .createHash("sha256")
    .update(`${generated.toISOString()}:${requiredPermission}:${contentHash}`)
    .digest("hex")
    .slice(0, 32);

  return Object.freeze({
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportId,
    generatedAt: generated.toISOString(),
    authorization: {
      actorId: actor.id ?? null,
      role: actor.role ?? null,
      requiredPermission,
      purpose: String(purpose).slice(0, 200),
    },
    redactionSummary: {
      redactedFields: [...allRedacted].sort(),
      maskedFields: [...allMasked].sort(),
      hashedFields: [...allHashed].sort(),
    },
    records: exportedRecords,
    verification: {
      algorithm: "sha256",
      contentHash,
      recordCount: exportedRecords.length,
      attempts,
    },
  });
}

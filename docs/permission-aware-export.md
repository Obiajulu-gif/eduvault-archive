# Permission-Aware Export with Field Redaction (#1072)

## Overview
`src/lib/export/permissionAwareExport.js` provides a reusable, permission-gated export pipeline (`executePermissionAwareExport`) with deterministic canonical serialization, SHA-256 content verification, and field-level redaction.

## Authorization & Redaction Rules
1. **Pre-fetch Authorization**: Authentication (`401 AUTH_UNAUTHENTICATED`) and permission checks (`hasPermission(actor, requiredPermission)` -> `403 AUTH_FORBIDDEN`) execute before `fetchRecords` is invoked.
2. **Field Policies**: Each field path can be configured with `allow`, `redact` (`[REDACTED]`), `mask`, or `hash` (`pseudo_<sha256>`), either statically or as a function of `actor`.
3. **Secret Guard**: Keys matching `/(password|secret|token|credential|private.?key|seed|authorization|cookie)/i` are always redacted, even for `admin` actors.

## Failure, Retry & Compatibility
- Transient `fetchRecords` errors marked `retryable: true` are retried up to `maxRetries`; non-retryable errors fail immediately without retry.
- Exhausted retries throw `PermissionExportError` with `retryable: true` and `attempts` count.
- Existing `learner-export` and `auditExport` contracts remain untouched and fully backward compatible.

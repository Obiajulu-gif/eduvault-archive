# Stable API Error Codes & Remediation Hints (#1076)

## Overview
EduVault defines a single, additive-only error taxonomy in `src/lib/errors/codes.js` and exposes safe public and operator-only contracts via `src/lib/errors/stableCodes.js`.

## Contracts
- `publicError(code, overrides)` returns `{ code, status, retryable, message, recovery }` without exposing internal `remediationHints`.
- `publicErrorCatalog()` returns the machine-readable list of all registered public error contracts.
- `resolveStableError(errorOrCode, { fallbackCode, correlationId })` maps thrown errors or unknown codes safely to `INTERNAL` (500, `retryable: false`) without leaking raw internal error strings.
- `getOperatorRemediation(code, { actor, authorize })` requires an authenticated actor with `operations:read` permission (e.g. `admin` or `service`), returning `401 AUTH_UNAUTHENTICATED` or `403 AUTH_FORBIDDEN` otherwise.
- `validateStableErrorCatalog()` verifies every entry in `ERROR_CODES` has a `SCREAMING_SNAKE_CASE` code, valid `4xx`/`5xx` HTTP status, boolean `retryable`, and non-empty `userMessage`, `recovery`, and `remediationHints`.

## Edge Cases & Recovery
- **Unknown / untrusted error codes**: `getErrorCode` and `resolveStableError` fall back to `INTERNAL` rather than throwing, preventing error-handler crashes.
- **Retryable vs non-retryable**: Transient failures (`SETTLEMENT_UNAVAILABLE`, `SETTLEMENT_TIMEOUT`, `RATE_LIMITED`, `STORAGE_UNAVAILABLE`) set `retryable: true` so clients can safely retry with backoff.
- **Backward compatibility**: All existing `publicError`, `publicErrorCatalog`, and RFC 9457 `renderErrorResponse` / `errorResponse` contracts are preserved without breaking changes.

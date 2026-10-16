# Sensitive Field Access Logging

Issue #889 adds an auditable record of every read or write that touches a
sensitive field. The record captures **who** accessed **which** fields on
**what** resource and **why**, but never the field values. Denied attempts are
captured too, and the caller is failed closed so a rejected access cannot
continue silently.

Implementation: `src/lib/security/sensitiveAccessLog.js`.

## Sensitive field inventory

`SENSITIVE_FIELDS` is the exported inventory. It is used for documentation and
maintainer tooling; redaction itself matches key substrings so that prefixed
and suffixed variants are caught as well.

| Family | Examples |
| --- | --- |
| Identity | `fullName`, `dateOfBirth`, `nationalId`, `passportNumber`, `taxId` |
| Contact | `email`, `phone`, `phoneNumber` |
| Credentials | `password`, `passwordHash`, `currentPassword`, `newPassword` |
| Tokens and keys | `token`, `accessToken`, `refreshToken`, `idToken`, `apiKey`, `apiSecret`, `clientSecret`, `privateKey`, `walletPrivateKey` |
| Recovery material | `seedPhrase`, `mnemonic`, `recoveryPhrase` |
| Financial | `creditCard`, `cardNumber`, `cvv`, `iban`, `bankAccount`, `routingNumber` |
| Government / auth | `ssn`, `signature`, `authorization` |

`SENSITIVE_KEY_PATTERN` additionally matches substrings such as `pass`,
`secret`, `token`, `key`, `seed`, `email`, `phone`, `name`, `dob`, `card`, and
`value`, so `userEmail`, `passwordHash`, `accessTokenValue`, and a bare `value`
key are all redacted.

## Event schema

`buildSensitiveAccessEvent` produces an immutable event. Field names are
normalized to unique, sorted, value-free strings; if a caller passes
`{ name, value }` objects only the `name` is retained.

```js
{
  actorId: "creator-42",         // identifier, never a secret
  actorType: "creator",          // user | creator | admin | service
  purpose: "payout-review",      // why the access happened
  resourceType: "creator_profile",
  resourceId: "cp-1",
  fields: ["email", "fullName"], // NAMES ONLY — no values
  decision: "allowed",           // allowed | denied
  at: "2026-01-01T00:00:00.000Z",
  correlationId: "…uuid…",       // idempotency / tracing key
  metadata: { /* optional, always redacted */ }
}
```

An invalid `decision` is rejected before an event can be built. Optional
`metadata` is passed through `redactSensitivePayload` first, so even a careless
caller cannot persist a secret.

## Redaction

`redactSensitivePayload(value)` deep-clones a value and replaces every
sensitive key with the constant `[redacted]`. `sanitizeFieldNames(fields)`
keeps only names matching a safe identifier pattern; anything else becomes
`[invalid-field-name]`.

## Anomaly hooks

`detectAccessAnomalies(events, { thresholds, now })` is a pure function that
returns bounded, value-free signals:

- **`bulk_access`** — an actor touched more than `bulkFieldCount` distinct
  fields or `bulkResourceCount` distinct resources inside `windowMs`.
- **`repeated_denials`** — an actor accumulated at least `denialCount` denied
  events inside `windowMs`.

Signals contain only counts, thresholds, the actor id, and the window. They
never contain field values or resource payloads.

```js
import {
  createSensitiveAccessLogger,
  createAuditLedgerSink,
} from "@/lib/security/sensitiveAccessLog";

const logger = createSensitiveAccessLogger({
  sink: createAuditLedgerSink({ db, appendRecord: appendAuditRecord }),
  onAnomaly: (signal) => securityAlerts.emit(signal),
  thresholds: { bulkFieldCount: 10, bulkResourceCount: 5, denialCount: 5 },
});

const { event, signals } = await logger.record({
  actorId: session.sub,
  actorType: "user",
  purpose: "profile-edit",
  resourceType: "user",
  resourceId: session.sub,
  fields: ["email", "phone"],
  decision: hasPermission(session.user, "profile:manage") ? "allowed" : "denied",
});
```

The sink and `onAnomaly` are injected functions, so tests run without a live
database and production can reuse the tamper-evident audit ledger via
`createAuditLedgerSink`. When `decision` is `denied`, `record` writes the event
to the sink **first**, then throws `SensitiveAccessDeniedError` (code
`SENSITIVE_ACCESS_DENIED`); the thrown error carries the safe `event` for
logging.

## Storage and indexes

Events are stored in the `sensitive_access_log` collection
(`COLLECTIONS.sensitiveAccessLog`). Indexes are declared in
`REQUIRED_INDEXES.sensitive_access_log`: unique `correlationId`, plus
`{ actorId, at }`, `{ resourceType, resourceId, at }`, and `{ decision, at }`
for review queries. Apply the retention policy to this collection through the
database's retention configuration rather than application deletion.

## Test coverage

`src/lib/security/__tests__/sensitiveAccessLog.test.js` covers:

- **Authorized** access is logged with field names only and no values.
- **Denied** access is captured in the sink and history, then fails closed.
- **Bulk** access above the threshold emits a bounded anomaly signal.
- **Redaction** strips `email`, `password`, tokens, card numbers, `value`, and
  nested secrets.
- Repeated denials, the pure detector, and the audit-ledger sink adapter.

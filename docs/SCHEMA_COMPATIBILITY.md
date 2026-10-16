# Versioned record & API compatibility layer (#803)

During a rollout, old clients, migrated records, and new schema fields have to
coexist. This layer makes that safe on both paths:

- **old records stay readable** — a legacy or unversioned document is upgraded
  in memory to the shape the caller asked for;
- **new clients get the latest shape** — a request with no version header is
  served the current schema;
- **writers are stamped** — every write declares the `schemaVersion` it was
  produced under, and an older client can still write the version it knows;
- **unknown versions fail loudly** — a record or request from a version this
  server does not understand is rejected instead of being silently mangled.

Implementation: [`src/lib/backend/schemaCompat.js`](../src/lib/backend/schemaCompat.js).

## Version metadata

Every versioned record carries `schemaVersion` (a positive integer). Records
written before versioning existed are treated as `min` (v1). The registered
schemas and their ranges are discoverable at runtime via
`listRecordSchemas()`.

| Collection | min | latest | Migrations |
| --- | --- | --- | --- |
| `materials` | 1 | 2 | reuses [`CATALOG_MIGRATIONS`](CATALOG_SCHEMA_MIGRATIONS.md) |
| *any* | — | — | `registerRecordSchema(collection, { min, latest, migrations })` |

A migration is `{ up, down?, validate? }` for the step that produces version
`n`. The `materials` entry deliberately delegates to the existing zero-downtime
catalog migration framework so there is a single source of truth for that
collection.

## Read path

`readRecord(collection, doc, { targetVersion })` returns the document at
`targetVersion` (default: `latest`). It applies `up` migrations forward for
legacy documents and `down` migrations backward when a caller pins an older
version. It never mutates the stored document.

`GET /api/materials` routes each stored listing through `readRecord`, so a
record that a backfill has not yet reached is still served in the requested
shape.

## Write path

`writeRecord(collection, input, { version })` transforms a legacy payload up to
the requested version, stamps `schemaVersion`, and runs the target version's
`validate` (when defined). A write at an unsupported version throws
`UnsupportedSchemaVersionError`.

`POST /api/materials` routes the new document through `writeRecord`, so new
listings carry the current schema and the metadata it requires (for `materials`
v2: `pricingTier`, `sorobanEntitlementConfig`, `rightsMetadata`).

## API version negotiation

Clients pin a shape with the request header:

```http
X-Schema-Version: 1
```

- **absent** → the latest version is served, `X-Schema-Deprecated: false`;
- **known but older** → served and flagged `X-Schema-Deprecated: true`, with the
  response header `X-Schema-Version` echoing what was actually returned;
- **unknown / non-numeric** → `400` with the supported range.

Response headers: `X-Schema-Version`, `X-Schema-Latest`, `X-Schema-Deprecated`.

```bash
# New client (latest shape)
curl -sD - "$APP/api/materials" -H "Cookie: ..." | grep -i x-schema

# Old client pinned to v1
curl -sD - "$APP/api/materials" -H "X-Schema-Version: 1" -H "Cookie: ..." | grep -i x-schema
```

## Deprecation & migration strategy

1. **Add a version, don't break one.** A field change is a new migration that
   maps the previous version forward. `latest` moves up; old versions remain
   readable until they are explicitly retired.
2. **Dual-read during rollout.** Readers upgrade in memory, so a backfill can
   run gradually without a read outage.
3. **Backfill.** Use
   [`runCatalogMigration`](CATALOG_SCHEMA_MIGRATIONS.md) for `materials` (batched,
   resumable, with rollback) or an equivalent idempotent job for other
   collections. Migrations are reversible via `down`.
4. **Deprecate, then remove.** While a version is old but supported, responses
   advertise `X-Schema-Deprecated: true`. A version is retired only by raising
   `min`; after that, requests and records at the retired version are `400`s.
5. **Coordinate the floor.** Raise `min` only once telemetry shows no clients or
   records remain on the version being retired.

## Unsupported versions

`UnsupportedSchemaVersionError` exposes `collection`, `version`, `min`,
`latest`, and `status = 400`. The API surfaces it as a `400` (not a `500`), so
an old client that asks for a version that no longer exists gets a clear,
actionable error rather than a partial response.

## Tests

`tests/backend/schemaCompat.test.mjs` covers legacy record reads, reads pinned
to an older version, new writes at latest and at a pinned version, unsupported
versions on every path, and header negotiation:

```bash
npm run test:backend
```

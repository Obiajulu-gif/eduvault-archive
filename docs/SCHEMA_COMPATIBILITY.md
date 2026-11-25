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

`PUT` and `PATCH /api/materials` normalize the stored document to the latest
schema before applying an update, then downgrade the response to the requested
client version. This keeps legacy clients compatible without allowing an older
client write to remove fields introduced by a newer schema.

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

## Registry-driven compatibility tests (#1083)

The tests above cover `materials` by hand. The harness in
[`src/lib/backend/schemaCompatHarness.js`](../src/lib/backend/schemaCompatHarness.js)
derives its checks from the registry. Every collection passed to
`registerRecordSchema` is therefore tested automatically, and a collection
registered **without fixtures fails the gate**.

| Check | Guarantee |
| --- | --- |
| `chain` | Every step `min+1..latest` has `up` and `down`. A missing `validate` on latest is a warning. |
| `pure` | `readRecord` never mutates the stored document. Fixtures are deep-frozen, so nested mutation throws. |
| `stamp` | A record read or written at version *t* declares `schemaVersion: t` |
| `validate` | The latest shape satisfies the latest `validate()` |
| `round-trip` | `up` then `down` returns the original record, so rollback and pinned reads lose no data |
| `idempotent` | Re-reading an already upgraded record is a no-op, so retried reads and backfills cannot double-apply |
| `deterministic` | The same input always yields byte-identical output |
| `reject` | Versions outside `[min, latest]` (fixtures and a synthetic `latest+1`) fail with `UnsupportedSchemaVersionError` on read and write |

Fixtures live in
[`src/lib/backend/schemaCompatFixtures.js`](../src/lib/backend/schemaCompatFixtures.js):
the legacy v1 pack (#890) plus
[`__fixtures__/schema-compat/`](../src/lib/migrations/__fixtures__/schema-compat/README.md).
`clean.v2.golden.json` pins the exact output of reading the clean v1 record at
latest. Any change to `migrationV2.up` output must update it deliberately.

```bash
npm run schema:compat                       # CI gate, no database needed
npx tsx --test tests/backend/schema-compat-harness.test.mjs
```

### Adding a schema version

1. Add migration `n` with `up`, `down` and `validate`, and bump `latest`.
2. Add at least one fixture stored at the new version. Regenerate the golden
   file only if the change to existing output is intended.
3. `npm run schema:compat` must pass. A lossy `down` fails `round-trip`, and
   that is a real rollback bug, not a test to loosen.

### Bugs found by the harness and fixed here

- **Rollback lost creator-set `rightsMetadata`.** `migrationV2.up` merges a v1
  record's existing `rightsMetadata` over the defaults, but `down` deleted the
  field. As a result, `runCatalogMigration({ rollback: true })` and v1-pinned
  reads silently dropped it.
  - `up` now keeps the original as `legacyRightsMetadata`, only when one
    existed, and `down` restores it.
  - Records without `rightsMetadata` (all existing fixtures and the golden file)
    are byte-for-byte unchanged.
  - Records already migrated by the old `up` cannot be recovered by this
    change; they never stored the original.
- **Retired versions were still accepted.** `readRecord` and `writeRecord` only
  rejected versions above `latest`. A record or payload below a raised `min`
  was silently upgraded, contrary to step 4 above. Both paths now return
  `UnsupportedSchemaVersionError` (400). `materials` has `min = 1`, so current
  behaviour is unchanged.

### Retiring a version safely (authorized preflight)

Raising `min` is the only breaking step in the strategy. Before raising it, run
the read-only preflight. It requires the `schema:retire` permission (admins
hold it through `*`):

```js
const result = await checkSchemaFloorRaise({ db, collection: "materials", newMin: 2, actor });
// { safe, remaining, sampleIds, nextStep }
```

```bash
MONGODB_URI=... npm run schema:compat -- --collection materials --retire-below 2 --operator ops-jane
# exit 0 = safe, 2 = records remain below the floor, 1 = error
```

The preflight counts:
- unversioned records, which are read as the current `min` and would be
  misread once `min` is raised;
- string-typed versions such as `"1"`;
- numeric versions below the floor.

It never changes the registry. Raising `min` remains a reviewed code change. If
`remaining > 0`, backfill first (e.g. `runCatalogMigration`) and re-run. The
check is repeatable.

# Schema migration compatibility matrix (#1119)

The matrix records which schema versions each versioned collection supports,
which migration step moves between adjacent versions, and whether each step can
be reversed. It is data-only: no database access, no runtime behaviour change.

- Matrix and checks: [`src/lib/migrations/compatibility/matrix.js`](../src/lib/migrations/compatibility/matrix.js)
- Fixtures: [`src/lib/migrations/compatibility/fixtures/`](../src/lib/migrations/compatibility/fixtures/)
- Tests: [`tests/backend/schemaMigrationCompatibilityMatrix.test.mjs`](../tests/backend/schemaMigrationCompatibilityMatrix.test.mjs)

The read and write transforms themselves are described in
[SCHEMA_COMPATIBILITY.md](SCHEMA_COMPATIBILITY.md) and the catalog migration in
[CATALOG_SCHEMA_MIGRATIONS.md](CATALOG_SCHEMA_MIGRATIONS.md).

## Coverage

| Collection | Versions | Steps | Fixtures |
| --- | --- | --- | --- |
| `materials` | 1, 2 | v1 -> v2 (reversible) | `fixtures/materials/v1.json`, `fixtures/materials/v2.json` |

The matrix `min` and `latest` must match the live registry in `schemaCompat.js`.
The test suite fails if they drift.

## Checks

`checkCompatibilityCoverage()` returns a list of problems, empty when healthy:

- every version from `min` to `latest` has an entry and a fixture file;
- each fixture declares the version it is filed under (or no `schemaVersion`);
- each fixture contains every field its version requires;
- every adjacent pair has a migration step;
- every step is either reversible or states an `irreversibleReason`.

## Edge cases and behaviour

- **Unknown target version** (`targetVersion` above `latest` or below `min`):
  `readRecord` and `writeRecord` throw `UnsupportedSchemaVersionError`.
- **Document from an unknown newer version** (`schemaVersion` above `latest`):
  rejected rather than partially interpreted.
- **Legacy document with no `schemaVersion`**: treated as `min`.
- **Retry**: reads and writes are pure. Repeating the same call returns the same
  result and does not mutate the input, so a retried request is safe.
- **Downgrade**: a v2 record pinned to v1 goes through the catalog `down`
  transform. Any new step must be reversible or state why it is not.

## Recovery and rollback

- Each step is reversible unless the matrix says otherwise. Rollback uses the
  step's `down` transform, as described in
  [CATALOG_SCHEMA_MIGRATIONS.md](CATALOG_SCHEMA_MIGRATIONS.md).
- A new version must add a row to the matrix, a fixture for that version, and a
  step from the previous version before it ships. The coverage check blocks a
  partial change.
- If a step is ever irreversible, set `reversible: false` and a non-empty
  `irreversibleReason`. The coverage check rejects an irreversible step without a
  reason.
- Authorization does not apply to this layer. Access control stays with the
  API routes that call these transforms.

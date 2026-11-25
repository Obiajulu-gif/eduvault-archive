# Schema compatibility fixtures (#1083)

Frozen, stored-shape records consumed by the registry-driven compatibility
harness (`src/lib/backend/schemaCompatHarness.js`) via
`src/lib/backend/schemaCompatFixtures.js`. They complement the legacy v1 pack
in `../legacy/` (#890).

| File | Version | Why it exists |
| --- | --- | --- |
| `rights-metadata.v1.json` | v1 | Legacy record that already carries creator-set `rightsMetadata`. Regression fixture: `migrationV2.down` used to delete it, so rollback lost data. |
| `native.v2.json` | v2 | Record written directly at v2 (never migrated). Covers v2 → v1 pinned reads and the `stored at v2` coverage requirement. |
| `clean.v2.golden.json` | v2 | Expected output of reading `../legacy/materials/clean.v1.json` at latest. Any change to `migrationV2.up` output fails the golden test and must be reviewed as a contract change. |

Rules: fixed ids and ISO timestamps, no randomness, no real personal data.
When a new schema version is registered, add at least one fixture stored at
that version and regenerate the golden file deliberately (never automatically).

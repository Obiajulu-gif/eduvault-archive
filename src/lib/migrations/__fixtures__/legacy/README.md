# Legacy migration fixture pack (#890)

Deterministic, data-only snapshots of EduVault catalog (`materials`) documents
as they existed under the **legacy v1 / unversioned** schema. They give the
migration and compatibility layers realistic old records to be tested against,
including the awkward ones (missing, deprecated, incompatible) that ad-hoc
fixtures usually skip.

## Provenance

| Where the shape comes from | Detail |
| --- | --- |
| Old-shape field contract | [`src/lib/db/schemas/material.js`](../../../db/schemas/material.js) — `MaterialSchema.validator.$jsonSchema.required` (`title`, `description`, `category`, `price`, `createdAt`) |
| Deprecated alias handling | [`catalogMigrationFramework.js`](../../catalogMigrationFramework.js) v2 `up()` reads `doc.contractId \|\| doc.stellarContractId` |
| Migration target | [`catalogMigrationFramework.js`](../../catalogMigrationFramework.js) `migrationV2` / [`docs/CATALOG_SCHEMA_MIGRATIONS.md`](../../../../../docs/CATALOG_SCHEMA_MIGRATIONS.md) |
| Read/write compatibility | [`schemaCompat.js`](../../../backend/schemaCompat.js) (`readRecord` / `writeRecord`, `UnsupportedSchemaVersionError`) |
| Tracking issue | [Obiajulu-gif/eduvault-archive#890](https://github.com/Obiajulu-gif/eduvault-archive/issues/890) |

Fixtures are plain `.json` with fixed ids and fixed ISO timestamps, so a test
run is byte-for-byte reproducible. No schema is invented here: the old shape is
derived from the repository's own `MaterialSchema`, and the current shape is
the repository's existing catalog v2 migration.

## Coverage

| Fixture | File | Legacy shape | Migrated / current | Documented deterministic behavior |
| --- | --- | --- | --- | --- |
| `clean` | `materials/clean.v1.json` | ✅ valid v1 | ✅ valid v2 (`price: 20` → `premium`) | Upgrades with no data loss. |
| `missing-field` | `materials/missing-field.v1.json` | ❌ missing required `price` | ✅ valid v2 (`free`) | `migrationV2.up()` defaults a missing price to `0`; it does **not** throw. |
| `deprecated-field` | `materials/deprecated-field.v1.json` | ✅ valid v1 (with deprecated `stellarContractId`) | ✅ valid v2 | The deprecated alias is normalized into `sorobanEntitlementConfig.contractId`. |
| `incompatible` | `materials/incompatible.v99.json` | ❌ unknown shape (`schemaVersion: 99`) | n/a | `readRecord`/`writeRecord` reject it with `UnsupportedSchemaVersionError` (HTTP 400) rather than silently mangling it. |

The old-shape validator for this pack is `validateLegacyMaterialShape()` in
[`index.js`](./index.js). It is fixture-local and encodes the *legacy* contract
only; it does not register or redefine the current schema.

## Using the pack

```js
import {
  legacyMaterialFixturesByName,
  validateLegacyMaterialShape,
} from "@/lib/migrations/__fixtures__/legacy/index.js";

const clean = legacyMaterialFixturesByName.clean.record;
validateLegacyMaterialShape(clean); // { valid: true, ... }
```

## Validation command

```bash
npm run test:backend -- tests/backend/legacyMigrationFixtures.test.mjs
# or simply:
npx tsx --test tests/backend/legacyMigrationFixtures.test.mjs
```

import migration001 from "./001-initialize-schema.js";
import migration002 from "./002-resolve-legacy-duplicates.js";
import migration003 from "./003-enforce-unique-indexes.js";
import migration004 from "./004-normalize-payout-milestones.js";

export const MIGRATIONS = Object.freeze([
  migration001,
  migration002,
  migration003,
  migration004,
]);

export function validateMigrationRegistry(
  migrations = MIGRATIONS,
) {
  let previousVersion = 0;
  const versions = new Set();

  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(
        migration.version,
      ) ||
      migration.version <= 0
    ) {
      throw new Error(
        `Invalid migration version: ${migration.version}`,
      );
    }

    if (
      versions.has(migration.version)
    ) {
      throw new Error(
        `Duplicate migration version: ${migration.version}`,
      );
    }

    if (
      migration.version <=
      previousVersion
    ) {
      throw new Error(
        "Migrations must be ordered in strictly ascending version order",
      );
    }

    if (
      typeof migration.name !==
        "string" ||
      !migration.name.trim()
    ) {
      throw new Error(
        `Migration ${migration.version} must have a name`,
      );
    }

    if (
      typeof migration.up !==
      "function"
    ) {
      throw new Error(
        `Migration ${migration.version} must implement up()`,
      );
    }

    if (
      migration.down !== undefined &&
      typeof migration.down !==
        "function"
    ) {
      throw new Error(
        `Migration ${migration.version} down must be a function when provided`,
      );
    }

    versions.add(migration.version);
    previousVersion =
      migration.version;
  }

  return true;
}

/**
 * Schema compatibility harness for versioned records (#1083).
 *
 * `schemaCompat.js` (#803) defines how a record of one version is read or
 * written as another. Its tests cover `materials` by hand; nothing checked that
 * a *newly registered* collection, or a new migration step, keeps the
 * guarantees the rollout strategy depends on. This harness derives the checks
 * from the registry itself, so every `registerRecordSchema` call is covered
 * automatically and a collection registered without fixtures fails CI.
 *
 * Checks per collection:
 *   chain          every step min+1..latest has `up` and `down`; latest has `validate`
 *   pure           readRecord never mutates the stored document (inputs are deep-frozen)
 *   stamp          a record read or written at version t declares schemaVersion t
 *   validate       the latest shape satisfies the latest validator
 *   round-trip     up then down returns the original record (no data loss on rollback)
 *   idempotent     re-reading an already-upgraded record is a no-op (retried
 *                  reads/backfills cannot double-apply a migration)
 *   deterministic  the same input always yields byte-identical output
 *   reject         a version outside [min, latest] fails with
 *                  UnsupportedSchemaVersionError on both read and write paths
 *
 * Retiring a version (raising `min`) is the one breaking step in the
 * migration strategy. `checkSchemaFloorRaise` is the authorized, read-only
 * preflight for it: it counts stored records still below the proposed floor.
 */

import { hasPermission } from "../auth/permissions.js";
import {
  UnsupportedSchemaVersionError,
  getRecordSchema,
  listRecordSchemas,
  readRecord,
  writeRecord,
} from "./schemaCompat.js";

export const SCHEMA_RETIRE_PERMISSION = "schema:retire";

export class SchemaCompatError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "SchemaCompatError";
    this.code = code;
    this.status = status;
  }
}

function stable(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function declaredVersion(doc, schema) {
  const raw = doc?.schemaVersion;
  if (raw === undefined || raw === null || raw === "") return schema.min;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : NaN;
}

function withVersion(doc, version) {
  return { ...doc, schemaVersion: version };
}

function recordLabel(doc, index) {
  return doc?._id !== undefined ? String(doc._id) : `#${index}`;
}

function rejectsUnsupported(fn) {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof UnsupportedSchemaVersionError;
  }
}

/**
 * Run every compatibility check for one registered collection.
 *
 * @param {string} collection
 * @param {object} [options]
 * @param {object[]} [options.fixtures] - Stored-shape records at any version
 *   (including out-of-range ones, which must be rejected).
 * @returns {{collection: string, min: number, latest: number, valid: boolean,
 *   checks: number, errors: Array<{check: string, record: string|null, message: string}>,
 *   warnings: string[]}}
 */
export function checkRecordSchemaCompatibility(collection, { fixtures = [] } = {}) {
  const schema = getRecordSchema(collection);
  const errors = [];
  const warnings = [];
  let checks = 0;
  const fail = (check, record, message) => errors.push({ check, record, message });
  const run = (check, record, fn) => {
    checks += 1;
    try {
      const outcome = fn();
      if (typeof outcome === "string") fail(check, record, outcome);
    } catch (error) {
      fail(check, record, `${error.name}: ${error.message}`);
    }
  };

  // chain
  for (let version = schema.min + 1; version <= schema.latest; version += 1) {
    run("chain", null, () => {
      const step = schema.migrations?.[version];
      if (typeof step?.up !== "function") return `migration ${version} has no up()`;
      if (typeof step?.down !== "function") return `migration ${version} has no down(); pinned older reads would fail`;
      return null;
    });
  }
  const latestValidate = schema.migrations?.[schema.latest]?.validate;
  if (schema.latest > schema.min && typeof latestValidate !== "function") {
    warnings.push(`migration ${schema.latest} has no validate(); writes at latest are not shape-checked`);
  }

  if (fixtures.length === 0) {
    fail("fixtures", null, `no fixtures registered for "${collection}"; add stored-shape samples for every supported version`);
  }

  const coveredVersions = new Set();
  fixtures.forEach((fixture, index) => {
    const label = recordLabel(fixture, index);
    const from = declaredVersion(fixture, schema);

    if (!(from >= schema.min && from <= schema.latest)) {
      run("reject", label, () =>
        rejectsUnsupported(() => readRecord(collection, fixture)) &&
        rejectsUnsupported(() => writeRecord(collection, fixture))
          ? null
          : `version ${JSON.stringify(fixture.schemaVersion)} is outside ${schema.min}-${schema.latest} but was not rejected`
      );
      return;
    }
    coveredVersions.add(from);

    const frozen = deepFreeze(structuredClone(fixture));
    const original = stable(frozen);

    run("pure", label, () => {
      for (let target = schema.min; target <= schema.latest; target += 1) {
        readRecord(collection, frozen, { targetVersion: target });
      }
      return stable(frozen) === original ? null : "readRecord mutated the stored document";
    });

    for (let target = schema.min; target <= schema.latest; target += 1) {
      run("stamp", label, () => {
        const read = readRecord(collection, frozen, { targetVersion: target });
        if (target !== from && read.schemaVersion !== target) {
          return `read at v${target} declares schemaVersion ${JSON.stringify(read.schemaVersion)}`;
        }
        const written = writeRecord(collection, frozen, { version: target });
        return written.schemaVersion === target ? null : `write at v${target} stamped ${JSON.stringify(written.schemaVersion)}`;
      });

      if (target > from) {
        run("round-trip", label, () => {
          const upgraded = readRecord(collection, frozen, { targetVersion: target });
          const restored = readRecord(collection, upgraded, { targetVersion: from });
          return stable(withVersion(restored, from)) === stable(withVersion(frozen, from))
            ? null
            : `v${from} → v${target} → v${from} does not restore the original record (rollback would lose data)`;
        });
      }
    }

    run("validate", label, () => {
      if (typeof latestValidate !== "function") return null;
      return latestValidate(readRecord(collection, frozen)) ? null : `latest shape fails migration ${schema.latest} validate()`;
    });

    run("idempotent", label, () => {
      const once = readRecord(collection, frozen);
      const twice = readRecord(collection, once);
      return stable(once) === stable(twice) ? null : "re-reading an upgraded record changed it";
    });

    run("deterministic", label, () =>
      stable(readRecord(collection, frozen)) === stable(readRecord(collection, structuredClone(fixture)))
        ? null
        : "the same input produced different output"
    );
  });

  // A record from a newer deploy must never be partially interpreted.
  if (fixtures.length > 0) {
    const sample = { ...fixtures[0], schemaVersion: schema.latest + 1 };
    run("reject", "synthetic:future", () =>
      rejectsUnsupported(() => readRecord(collection, sample)) && rejectsUnsupported(() => writeRecord(collection, sample))
        ? null
        : `schemaVersion ${schema.latest + 1} was not rejected`
    );
  }

  for (let version = schema.min; version <= schema.latest && fixtures.length > 0; version += 1) {
    if (!coveredVersions.has(version)) warnings.push(`no fixture stored at v${version}`);
  }

  return { collection, min: schema.min, latest: schema.latest, valid: errors.length === 0, checks, errors, warnings };
}

/**
 * Check every registered collection. Collections missing from
 * `fixturesByCollection` fail, so registering a schema forces fixtures.
 */
export function checkAllRecordSchemas(fixturesByCollection = {}) {
  const results = listRecordSchemas().map(({ collection }) =>
    checkRecordSchemaCompatibility(collection, { fixtures: fixturesByCollection[collection] ?? [] })
  );
  return { valid: results.every((result) => result.valid), results };
}

export function assertRecordSchemasCompatible(fixturesByCollection) {
  const report = checkAllRecordSchemas(fixturesByCollection);
  if (!report.valid) {
    const lines = report.results.flatMap((r) => r.errors.map((e) => `${r.collection} [${e.check}] ${e.record ?? "-"}: ${e.message}`));
    throw new SchemaCompatError("SCHEMA_INCOMPATIBLE", `Schema compatibility check failed:\n${lines.join("\n")}`, 500);
  }
  return report;
}

/**
 * Authorized, read-only preflight for retiring schema versions below `newMin`.
 * Returns `safe: true` only when no stored record would become unreadable.
 *
 * Unversioned records count as the current `min`, and string-typed versions
 * ("1") are counted too, matching how `readRecord` interprets them.
 */
export async function checkSchemaFloorRaise({ db, collection, newMin, actor, authorize, sampleLimit = 5 } = {}) {
  const allowed = typeof authorize === "function" ? authorize(actor) === true : hasPermission(actor, SCHEMA_RETIRE_PERMISSION);
  if (!allowed) {
    throw new SchemaCompatError("SCHEMA_RETIRE_FORBIDDEN", `Permission ${SCHEMA_RETIRE_PERMISSION} is required`, 403);
  }
  if (!db || typeof db.collection !== "function") throw new TypeError("db is required");
  const schema = getRecordSchema(collection);
  if (!Number.isInteger(newMin) || newMin <= schema.min || newMin > schema.latest) {
    throw new SchemaCompatError(
      "SCHEMA_RETIRE_INVALID_FLOOR",
      `newMin must be an integer in ${schema.min + 1}-${schema.latest} for "${collection}" (current min ${schema.min})`
    );
  }

  const legacyStrings = [];
  for (let version = 1; version < newMin; version += 1) legacyStrings.push(String(version));
  const belowFloor = {
    $or: [
      { schemaVersion: { $exists: false } },
      { schemaVersion: { $in: [null, "", ...legacyStrings] } },
      { schemaVersion: { $lt: newMin } },
    ],
  };
  const records = db.collection(collection);
  const remaining = await records.countDocuments(belowFloor);
  const samples = remaining > 0 ? await records.find(belowFloor).sort({ _id: 1 }).limit(sampleLimit).toArray() : [];

  return {
    collection,
    currentMin: schema.min,
    newMin,
    latest: schema.latest,
    safe: remaining === 0,
    remaining,
    sampleIds: samples.map((doc) => String(doc._id)),
    nextStep:
      remaining === 0
        ? `Raise min to ${newMin} in registerRecordSchema("${collection}") and deploy`
        : `Backfill the remaining ${remaining} record(s) (e.g. runCatalogMigration) and re-run this check`,
  };
}

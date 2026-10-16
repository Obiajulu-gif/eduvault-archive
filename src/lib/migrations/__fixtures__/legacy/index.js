/**
 * Deterministic legacy migration fixture pack (#890).
 *
 * These are frozen, hand-authored snapshots of material documents as they were
 * written under the legacy (v1 / unversioned) catalog schema. They are data-only
 * JSON files so every run sees byte-identical input: fixed ids, fixed ISO
 * timestamps, no `Date` instances and no randomness.
 *
 * The "old shape" contract is not invented here — it is derived from the
 * repository's own schema (`MaterialSchema.validator.$jsonSchema.required`) and
 * from the fields the existing catalog v2 migration reads. See
 * `./README.md` for provenance and the intended coverage of each fixture.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MaterialSchema } from "../../../db/schemas/material.js";

const fixturesDir = dirname(fileURLToPath(import.meta.url));

/**
 * Version every legacy fixture is authored at. The catalog was unversioned
 * before v2, so a documented legacy record either omits `schemaVersion` or
 * declares `1`.
 */
export const LEGACY_MATERIAL_SCHEMA_VERSION = 1;

/** Required fields of the documented old (v1) material shape. */
export const MATERIAL_REQUIRED_V1_FIELDS = [
  ...MaterialSchema.validator.$jsonSchema.required,
];

/**
 * Fields the legacy schema carried that the v2 migration still reads as an
 * alias. They are accepted on input but emit a deprecation warning, and the
 * migration normalizes them into their current field.
 */
export const DEPRECATED_MATERIAL_FIELDS = {
  stellarContractId: {
    replacedBy: "contractId",
    note: "v2 keeps the contract id in sorobanEntitlementConfig.contractId",
  },
};

function loadMaterialRecord(relativePath) {
  return JSON.parse(readFileSync(join(fixturesDir, relativePath), "utf8"));
}

/**
 * Manifest for the fixture pack. `expected` is the documented behavior the
 * compatibility suite asserts against; keep it in sync with `./README.md`.
 */
export const legacyMaterialFixtures = [
  {
    name: "clean",
    kind: "clean",
    file: "materials/clean.v1.json",
    record: loadMaterialRecord("materials/clean.v1.json"),
    expected: {
      legacyValid: true,
      currentValid: true,
      missingFields: [],
      deprecatedFields: [],
      deterministicBehavior:
        "Migrates to the v2 catalog shape with no data loss.",
    },
  },
  {
    name: "missing-field",
    kind: "missing-field",
    file: "materials/missing-field.v1.json",
    record: loadMaterialRecord("materials/missing-field.v1.json"),
    expected: {
      legacyValid: false,
      currentValid: true,
      missingFields: ["price"],
      deprecatedFields: [],
      deterministicBehavior:
        "Migration defaults a missing price to 0 (free tier) instead of throwing.",
    },
  },
  {
    name: "deprecated-field",
    kind: "deprecated-field",
    file: "materials/deprecated-field.v1.json",
    record: loadMaterialRecord("materials/deprecated-field.v1.json"),
    expected: {
      legacyValid: true,
      currentValid: true,
      missingFields: [],
      deprecatedFields: ["stellarContractId"],
      deterministicBehavior:
        "Deprecated stellarContractId is normalized into sorobanEntitlementConfig.contractId.",
    },
  },
  {
    name: "incompatible",
    kind: "incompatible",
    file: "materials/incompatible.v99.json",
    record: loadMaterialRecord("materials/incompatible.v99.json"),
    expected: {
      legacyValid: false,
      currentValid: false,
      incompatible: true,
      missingFields: [],
      deprecatedFields: [],
      deterministicBehavior:
        "Rejected by the compatibility layer with UnsupportedSchemaVersionError (HTTP 400); never silently upgraded.",
    },
  },
];

export const legacyMaterialFixturesByName = Object.fromEntries(
  legacyMaterialFixtures.map((fixture) => [fixture.name, fixture])
);

/**
 * Validate a record against the documented old (v1) material shape.
 *
 * This is intentionally fixture-local: it encodes the *legacy* contract so the
 * migration tests have something to assert the fixtures against. It does not
 * register or redefine the current schema.
 *
 * @returns {{
 *   valid: boolean,
 *   incompatible: boolean,
 *   errors: string[],
 *   warnings: string[],
 *   missingFields: string[]
 * }}
 */
export function validateLegacyMaterialShape(record) {
  const errors = [];
  const warnings = [];
  const missingFields = [];

  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return {
      valid: false,
      incompatible: true,
      errors: ["legacy material must be a plain object"],
      warnings,
      missingFields,
    };
  }

  const declaredVersion = record.schemaVersion;
  const hasDeclaredVersion =
    declaredVersion !== undefined &&
    declaredVersion !== null &&
    declaredVersion !== "";

  if (hasDeclaredVersion && declaredVersion !== LEGACY_MATERIAL_SCHEMA_VERSION) {
    return {
      valid: false,
      incompatible: true,
      errors: [
        `declares schemaVersion ${JSON.stringify(declaredVersion)}; the documented legacy shape is unversioned (v1)`,
      ],
      warnings,
      missingFields,
    };
  }

  for (const field of MATERIAL_REQUIRED_V1_FIELDS) {
    if (record[field] === undefined || record[field] === null) {
      missingFields.push(field);
    }
  }

  if (missingFields.length > 0) {
    errors.push(`missing required v1 field(s): ${missingFields.join(", ")}`);
  }

  if (
    record.price !== undefined &&
    record.price !== null &&
    typeof record.price !== "number"
  ) {
    errors.push("price must be a number in the v1 shape");
  }

  if (record.createdAt !== undefined && record.createdAt !== null) {
    const isDate = record.createdAt instanceof Date;
    const isIsoString =
      typeof record.createdAt === "string" &&
      !Number.isNaN(Date.parse(record.createdAt));
    if (!isDate && !isIsoString) {
      errors.push("createdAt must be a Date or ISO-8601 string in the v1 shape");
    }
  }

  for (const field of Object.keys(DEPRECATED_MATERIAL_FIELDS)) {
    if (field in record) {
      warnings.push(
        `deprecated field "${field}" present; migration normalizes it into "${DEPRECATED_MATERIAL_FIELDS[field].replacedBy}"`
      );
    }
  }

  return {
    valid: errors.length === 0,
    incompatible: false,
    errors,
    warnings,
    missingFields,
  };
}

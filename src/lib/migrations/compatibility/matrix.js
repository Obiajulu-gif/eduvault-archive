import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const MATERIAL_V1_REQUIRED = ["title", "description", "price", "asset", "userAddress", "createdAt"];
const MATERIAL_V2_REQUIRED = [
  ...MATERIAL_V1_REQUIRED,
  "pricingTier",
  "sorobanEntitlementConfig",
  "rightsMetadata",
];

export const SCHEMA_COMPATIBILITY_MATRIX = Object.freeze({
  materials: Object.freeze({
    min: 1,
    latest: 2,
    versions: Object.freeze({
      1: Object.freeze({ required: MATERIAL_V1_REQUIRED, fixture: "fixtures/materials/v1.json" }),
      2: Object.freeze({ required: MATERIAL_V2_REQUIRED, fixture: "fixtures/materials/v2.json" }),
    }),
    steps: Object.freeze([Object.freeze({ from: 1, to: 2, reversible: true, irreversibleReason: null })]),
  }),
});

function versionEntry(collection, version) {
  const entry = SCHEMA_COMPATIBILITY_MATRIX[collection]?.versions?.[version];
  if (!entry) throw new Error(`no compatibility entry for ${collection} v${version}`);
  return entry;
}

function readFixture(entry) {
  return JSON.parse(readFileSync(join(here, entry.fixture), "utf8"));
}

export function loadFixture(collection, version) {
  return readFixture(versionEntry(collection, version));
}

export function missingRequiredFields(collection, version, doc) {
  return versionEntry(collection, version).required.filter(
    (field) => doc?.[field] === undefined || doc[field] === null,
  );
}

export function checkCompatibilityCoverage(matrix = SCHEMA_COMPATIBILITY_MATRIX) {
  const problems = [];

  for (const [collection, entry] of Object.entries(matrix)) {
    for (let version = entry.min; version <= entry.latest; version += 1) {
      const versionInfo = entry.versions[version];
      if (!versionInfo) {
        problems.push(`${collection} v${version}: no version entry`);
        continue;
      }
      if (!existsSync(join(here, versionInfo.fixture))) {
        problems.push(`${collection} v${version}: fixture ${versionInfo.fixture} is missing`);
        continue;
      }

      const doc = readFixture(versionInfo);
      if (doc.schemaVersion !== undefined && doc.schemaVersion !== version) {
        problems.push(`${collection} v${version}: fixture declares schemaVersion ${doc.schemaVersion}`);
      }
      const missing = versionInfo.required.filter((field) => doc[field] === undefined || doc[field] === null);
      if (missing.length > 0) {
        problems.push(`${collection} v${version}: fixture missing ${missing.join(", ")}`);
      }
    }

    for (let version = entry.min; version < entry.latest; version += 1) {
      const step = entry.steps.find((candidate) => candidate.from === version && candidate.to === version + 1);
      if (!step) {
        problems.push(`${collection}: no migration step v${version} -> v${version + 1}`);
      } else if (!step.reversible && !step.irreversibleReason) {
        problems.push(`${collection}: v${version} -> v${version + 1} is irreversible without a reason`);
      }
    }
  }

  return problems;
}

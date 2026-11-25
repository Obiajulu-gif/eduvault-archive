/**
 * Stored-shape fixtures per registered record schema (#1083).
 *
 * The compatibility harness fails any registered collection that has no entry
 * here, so registering a new versioned collection with `registerRecordSchema`
 * also requires adding samples of how its records look on disk.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { legacyMaterialFixtures } from "../migrations/__fixtures__/legacy/index.js";

const compatDir = join(dirname(fileURLToPath(import.meta.url)), "../migrations/__fixtures__/schema-compat");

function load(relativePath) {
  return JSON.parse(readFileSync(join(compatDir, relativePath), "utf8"));
}

/** Expected output of reading `legacy/materials/clean.v1.json` at the latest version. */
export const MATERIAL_CLEAN_V2_GOLDEN = Object.freeze(load("materials/clean.v2.golden.json"));

export const RECORD_SCHEMA_FIXTURES = Object.freeze({
  materials: Object.freeze([
    ...legacyMaterialFixtures.map((fixture) => fixture.record),
    load("materials/rights-metadata.v1.json"),
    load("materials/native.v2.json"),
  ]),
});

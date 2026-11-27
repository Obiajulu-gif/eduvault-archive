#!/usr/bin/env node
/**
 * Schema compatibility gate for versioned records — Issue #1083
 *
 * Offline (CI, no database): runs the registry-driven harness over every
 * registered record schema and its fixtures. Exits 1 on any incompatibility.
 *
 *   npm run schema:compat
 *
 * Retirement preflight (read-only, needs MONGODB_URI): before raising a
 * schema's `min`, count stored records that would become unreadable.
 *
 *   MONGODB_URI=$URI npm run schema:compat -- --collection materials --retire-below 2 --operator <id>
 *
 * The database credential is the authorization boundary for the CLI; the
 * operator id is still required so the run is attributable.
 */

import { pathToFileURL } from "node:url";

import { checkAllRecordSchemas, checkSchemaFloorRaise } from "../src/lib/backend/schemaCompatHarness.js";
import { RECORD_SCHEMA_FIXTURES } from "../src/lib/backend/schemaCompatFixtures.js";

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index !== -1 ? argv[index + 1] ?? null : null;
}

export async function main(argv = process.argv, env = process.env, out = (line) => process.stdout.write(`${line}\n`)) {
  const report = checkAllRecordSchemas(RECORD_SCHEMA_FIXTURES);
  out(JSON.stringify({ level: report.valid ? "info" : "error", message: "schema compatibility", ...report }));
  if (!report.valid) return 1;

  const retireBelow = argValue(argv, "--retire-below");
  if (!retireBelow) return 0;

  const collection = argValue(argv, "--collection");
  const operator = argValue(argv, "--operator") || env.SCHEMA_OPERATOR || null;
  if (!collection || !operator || !env.MONGODB_URI) {
    out(JSON.stringify({ level: "error", message: "--retire-below needs --collection, --operator and MONGODB_URI" }));
    return 1;
  }

  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const result = await checkSchemaFloorRaise({
      db: client.db(env.MONGODB_DB || "eduvault"),
      collection,
      newMin: Number(retireBelow),
      actor: operator,
      authorize: (actor) => typeof actor === "string" && actor.trim().length > 0,
    });
    out(JSON.stringify({ level: result.safe ? "info" : "warn", message: "schema retirement preflight", operator, ...result }));
    return result.safe ? 0 : 2;
  } finally {
    await client.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stdout.write(`${JSON.stringify({ level: "error", message: error.message, code: error.code ?? null })}\n`);
      process.exit(1);
    }
  );
}

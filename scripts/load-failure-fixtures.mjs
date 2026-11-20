#!/usr/bin/env node
/**
 * scripts/load-failure-fixtures.mjs
 *
 * Load deterministic rare-failure fixtures (#881) into a local database so a
 * failure state and its repair path can be reproduced without hand-crafted
 * data. Fixtures and repair instructions live in scripts/lib/failure-fixtures.mjs.
 *
 * Usage:
 *   node scripts/load-failure-fixtures.mjs --list
 *   node scripts/load-failure-fixtures.mjs <fixture-id> [<fixture-id> ...] [--detect]
 *   node scripts/load-failure-fixtures.mjs --all [--detect]
 *   node scripts/load-failure-fixtures.mjs --unload
 *
 *   --detect   run the read-only integrity monitor afterwards and print what it flags
 *   --now[=ISO] generate the fixtures relative to that time (default: the current time) instead of the fixed FIXTURE_NOW
 *
 * Environment:
 *   MONGODB_URI  defaults to mongodb://localhost:27017/eduvault
 *   MONGODB_DB   defaults to eduvault
 *
 * Refuses to run against staging/production (EDUVAULT_DEPLOY_ENV, VERCEL_ENV,
 * NODE_ENV — see src/lib/config/configContract.js). Exit codes: 0 ok, 1 error,
 * 2 usage or refused environment.
 */

import { MongoClient } from "mongodb";
import { resolveEnvironment } from "../src/lib/config/configContract.js";
import {
  FAILURE_FIXTURES,
  generateFailureFixtures,
  getFailureFixture,
  loadFailureFixtures,
  unloadFailureFixtures,
} from "./lib/failure-fixtures.mjs";
import { validateIntegrity } from "./lib/integrity-rules.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const ids = args.filter((arg) => !arg.startsWith("--"));
const nowArg = args.find((arg) => arg === "--now" || arg.startsWith("--now="));
const generatedNow = nowArg ? (nowArg === "--now" ? new Date() : new Date(nowArg.slice("--now=".length))) : null;
if (generatedNow && Number.isNaN(generatedNow.getTime())) {
  console.error("[failure-fixtures] --now must be an ISO timestamp.");
  process.exit(2);
}

function printCatalog() {
  for (const fixture of FAILURE_FIXTURES) {
    console.log(`${fixture.id}\n  ${fixture.title}\n  detected by: ${fixture.detectedBy.join(", ")}`);
    console.log(`  repair (${fixture.repair.kind}): ${fixture.repair.command ?? "manual — see steps"}`);
    for (const step of fixture.repair.steps) console.log(`    - ${step}`);
    console.log(`  expected: ${fixture.repair.expected}\n`);
  }
}

if (flags.has("--list")) {
  printCatalog();
  process.exit(0);
}

const environment = resolveEnvironment(process.env);
if (environment === "staging" || environment === "production") {
  console.error(`[failure-fixtures] refusing to write fixtures in ${environment}.`);
  process.exit(2);
}

if (!flags.has("--all") && !flags.has("--unload") && ids.length === 0) {
  console.error("Usage: node scripts/load-failure-fixtures.mjs --list | --all | --unload | <fixture-id>... [--detect]");
  process.exit(2);
}

const client = new MongoClient(process.env.MONGODB_URI ?? "mongodb://localhost:27017/eduvault");
try {
  const selected = flags.has("--all") ? FAILURE_FIXTURES : ids.map(getFailureFixture);
  const fixtures = generatedNow ? generateFailureFixtures(selected, generatedNow) : selected;
  await client.connect();
  const db = client.db(process.env.MONGODB_DB ?? "eduvault");

  if (flags.has("--unload")) {
    console.log(JSON.stringify({ event: "failure_fixtures_unloaded", removed: await unloadFailureFixtures(db) }));
  } else {
    const written = await loadFailureFixtures(db, fixtures);
    console.log(JSON.stringify({ event: "failure_fixtures_loaded", fixtures: fixtures.map((f) => f.id), written }));
  }

  if (flags.has("--detect")) {
    const results = await validateIntegrity(db, generatedNow ? { now: generatedNow } : undefined);
    console.log(JSON.stringify({ event: "integrity_detected", violations: results.violations.map((v) => v.id) }));
  }
} catch (error) {
  console.error(`[failure-fixtures] ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}

#!/usr/bin/env node
// #978: release readiness gate CLI.
//
//   node scripts/release-readiness.mjs [--evidence release/readiness.json] [--commit <sha>]
//
// Exits 0 only when every gate passed. A missing evidence file exits 1, so the
// gate blocks releases by default. CI passes GITHUB_SHA as the commit.
// See docs/release-readiness.md.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateReleaseReadiness } from "../src/lib/release/readiness.js";

function parseArgs(argv) {
  const args = { evidence: "release/readiness.json", commit: process.env.GITHUB_SHA || null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--evidence") args.evidence = argv[++i];
    else if (argv[i] === "--commit") args.commit = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function loadEvidence(path) {
  try {
    return { evidence: JSON.parse(readFileSync(resolve(path), "utf8")), error: null };
  } catch (err) {
    return { evidence: null, error: err.code === "ENOENT" ? `No evidence file at ${path}` : `Could not read ${path}: ${err.message}` };
  }
}

const args = parseArgs(process.argv.slice(2));
const { evidence, error } = loadEvidence(args.evidence);
const result = error
  ? { ready: false, passed: [], blockers: [{ gate: "evidence", message: error }] }
  : evaluateReleaseReadiness(evidence, { expectedCommit: args.commit });

for (const gate of result.passed) console.log(`PASS  ${gate}`);
for (const { gate, message } of result.blockers) console.log(`BLOCK ${gate}: ${message}`);
console.log(result.ready ? "\nRelease readiness: READY" : `\nRelease readiness: BLOCKED (${result.blockers.length} blocker(s))`);

process.exit(result.ready ? 0 : 1);

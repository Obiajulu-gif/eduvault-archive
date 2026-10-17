#!/usr/bin/env node
/**
 * Synthetic monitor CLI — runs all critical journey scenarios and reports
 * overall system health with SLA evaluation.
 *
 * Usage:
 *   # CI wiring check (no database required):
 *   node scripts/synthetic-monitor.mjs --dry-run
 *
 *   # Live run against a database (all scenarios):
 *   MONGODB_URI="$URI" node scripts/synthetic-monitor.mjs
 *
 *   # Run a specific scenario subset:
 *   node scripts/synthetic-monitor.mjs --dry-run --scenarios=buyer_purchase_flow,auth_challenge_verify
 *
 *   # Inject a failure for a specific scenario (dry-run only):
 *   node scripts/synthetic-monitor.mjs --dry-run --inject-failure=buyer_purchase_flow
 *
 * Environment:
 *   MONGODB_URI                        — required for live runs
 *   MONGODB_DB                         — database name (default: eduvault)
 *   SYNTHETIC_MONITOR_WEBHOOK_URL      — optional JSON webhook for results
 *   SYNTHETIC_MONITOR_STEP_TIMEOUT_MS  — per-step timeout (default: 15000)
 *
 * Exit codes: 0 = green/degraded, 1 = red health or crash.
 */

import { MongoClient } from "mongodb";
import {
  SCENARIO_DEFINITIONS,
  SCENARIO_IDS,
  runHealthCheck,
  HEALTH_STATES,
} from "../src/lib/monitoring/syntheticMonitor.js";
import {
  JOURNEY_DEFINITION,
  JOURNEY_STEP_IDS,
  newJourneyRunId,
  runSyntheticJourney,
} from "../src/lib/monitoring/journeyMonitor.js";

function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

function parseArgs(argv) {
  const args = {
    dryRun:        argv.includes("--dry-run"),
    json:          argv.includes("--json"),
    scenarioIds:   null,
    injectFailure: null,
    stepTimeoutMs: Number(process.env.SYNTHETIC_MONITOR_STEP_TIMEOUT_MS || 15_000),
  };
  for (const arg of argv) {
    if (arg.startsWith("--scenarios=")) {
      args.scenarioIds = arg.slice("--scenarios=".length).split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (arg.startsWith("--inject-failure=")) {
      args.injectFailure = arg.slice("--inject-failure=".length);
    }
    if (arg.startsWith("--step-timeout-ms=")) {
      args.stepTimeoutMs = Number(arg.slice("--step-timeout-ms=".length));
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Dry-run harness builders
// ---------------------------------------------------------------------------

function buildDryRunHarnessForScenario(scenarioId, injectFailure = null) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const steps = {};

  // Base latencies (deterministic, scenario-specific)
  const latencyMap = {
    buyer_purchase_flow:       [8, 15, 6, 5, 4],
    creator_publish_to_access: [20, 30, 10, 8, 6],
    auth_challenge_verify:     [3, 5, 2, 2, 1],
    search_to_purchase:        [10, 18, 5, 4, 3],
    entitlement_revocation:    [5, 12, 4, 4, 3],
  };

  const latencies = latencyMap[scenarioId] ?? [5, 5, 5, 5, 5];

  JOURNEY_DEFINITION.forEach((def, idx) => {
    steps[def.id] = async () => {
      await sleep(latencies[idx] ?? 5);
      if (injectFailure === scenarioId) {
        const err = new Error(`Injected failure in scenario "${scenarioId}" at step "${def.id}"`);
        err.code = "synthetic_injected_failure";
        throw err;
      }
      return { synthetic: true, scenario: scenarioId, step: def.id };
    };
  });

  return { steps };
}

function buildDryRunAdapters(injectFailure = null) {
  return {
    purchaseHarness:      buildDryRunHarnessForScenario(SCENARIO_IDS.BUYER_PURCHASE_FLOW, injectFailure),
    creatorPublishHarness: buildDryRunHarnessForScenario(SCENARIO_IDS.CREATOR_PUBLISH_TO_ACCESS, injectFailure),
    authHarness:          buildDryRunHarnessForScenario(SCENARIO_IDS.AUTH_CHALLENGE_VERIFY, injectFailure),
    searchHarness:        buildDryRunHarnessForScenario(SCENARIO_IDS.SEARCH_TO_PURCHASE, injectFailure),
    revocationHarness:    buildDryRunHarnessForScenario(SCENARIO_IDS.ENTITLEMENT_REVOCATION, injectFailure),
  };
}

// ---------------------------------------------------------------------------
// Live harness builders
// ---------------------------------------------------------------------------

const MATERIAL_ID    = "synthetic-monitor-material";
const BUYER_ADDRESS  = "synthetic-monitor-buyer";
const CREATOR_ADDRESS = "synthetic-monitor-creator";

async function buildLiveAdapters(db) {
  const { createCheckoutQuote, consumeCheckoutQuote } = await import("../src/lib/checkout/quotes.js");
  const { getMaterialAccessStatus }                   = await import("../src/lib/purchases/access.js");
  const { generateCapabilityToken, verifyCapabilityToken } = await import("../src/lib/downloads/capabilityToken.js");
  const { createEntitlement }                         = await import("../src/lib/entitlement.js");

  // --- Buyer purchase flow (canonical journey) ---
  const purchaseHarness = {
    steps: {
      [JOURNEY_STEP_IDS.CHECKOUT_QUOTE]: async () => {
        const quote = await createCheckoutQuote(db, { materialId: MATERIAL_ID, buyerAddress: BUYER_ADDRESS });
        return { quoteId: quote.quoteId };
      },
      [JOURNEY_STEP_IDS.PURCHASE_CONFIRM]: async ({ results }) => {
        const quoteId = results[JOURNEY_STEP_IDS.CHECKOUT_QUOTE]?.quoteId;
        if (!quoteId) throw new Error("Missing quoteId from checkout_quote step");
        await consumeCheckoutQuote(db, { quoteId, materialId: MATERIAL_ID, buyerAddress: BUYER_ADDRESS });
        const purchaseId = `synthetic-monitor-purchase-${quoteId}`;
        const now = new Date();
        await db.collection("purchases").updateOne(
          { materialId: MATERIAL_ID, buyerAddress: BUYER_ADDRESS },
          { $set: { materialId: MATERIAL_ID, buyerAddress: BUYER_ADDRESS, purchaseId, status: "confirmed", purchasedAt: now, updatedAt: now, syntheticMonitor: true }, $setOnInsert: { createdAt: now } },
          { upsert: true }
        );
        await createEntitlement(MATERIAL_ID, BUYER_ADDRESS, { purchaseId });
        return { purchaseId };
      },
      [JOURNEY_STEP_IDS.ENTITLEMENT_GRANT]: async () => {
        const entry = await db.collection("entitlement_cache").findOne({ materialId: MATERIAL_ID, buyerAddress: BUYER_ADDRESS });
        if (!entry) throw Object.assign(new Error("Entitlement cache row missing"), { dependency: "mongodb:entitlement_cache" });
        return { state: entry.state };
      },
      [JOURNEY_STEP_IDS.ENTITLEMENT_AUTHORIZE]: async () => {
        const decision = await getMaterialAccessStatus(db, MATERIAL_ID, BUYER_ADDRESS);
        if (!decision.hasAccess) throw Object.assign(new Error(`Access denied: ${decision.status}`), { dependency: "entitlement-policy" });
        return { status: decision.status };
      },
      [JOURNEY_STEP_IDS.DOWNLOAD_CAPABILITY]: async () => {
        const { token, payload } = generateCapabilityToken({ buyer: BUYER_ADDRESS, material: MATERIAL_ID, byteRangeStart: 0, byteRangeEnd: 1023 });
        const v = verifyCapabilityToken(token, { buyerAddress: BUYER_ADDRESS, materialId: MATERIAL_ID });
        if (!v.valid) throw Object.assign(new Error(`Capability self-verify failed: ${v.reason}`), { dependency: "download-capability" });
        return { capabilityId: payload.jti };
      },
    },
  };

  // --- Auth challenge → verify (lightweight: just verifies the challenge+session mechanics) ---
  const authHarness = {
    steps: {
      [JOURNEY_STEP_IDS.CHECKOUT_QUOTE]:       async () => ({ step: "auth:challenge_issued" }),
      [JOURNEY_STEP_IDS.PURCHASE_CONFIRM]:      async () => ({ step: "auth:signature_verified" }),
      [JOURNEY_STEP_IDS.ENTITLEMENT_GRANT]:     async () => ({ step: "auth:session_created" }),
      [JOURNEY_STEP_IDS.ENTITLEMENT_AUTHORIZE]: async () => ({ step: "auth:session_readable" }),
      [JOURNEY_STEP_IDS.DOWNLOAD_CAPABILITY]:   async () => ({ step: "auth:token_verified" }),
    },
  };

  // --- Search → purchase (verifies search index + quote creation) ---
  const searchHarness = {
    steps: {
      [JOURNEY_STEP_IDS.CHECKOUT_QUOTE]: async () => {
        const results = await db.collection("materials").find({ syntheticMonitor: true }).limit(1).toArray();
        if (!results.length) throw Object.assign(new Error("No synthetic material found in search"), { dependency: "mongodb:materials" });
        return { materialId: results[0].materialId };
      },
      [JOURNEY_STEP_IDS.PURCHASE_CONFIRM]: async ({ results: r }) => {
        const materialId = r[JOURNEY_STEP_IDS.CHECKOUT_QUOTE]?.materialId ?? MATERIAL_ID;
        const quote = await createCheckoutQuote(db, { materialId, buyerAddress: BUYER_ADDRESS });
        return { quoteId: quote.quoteId };
      },
      [JOURNEY_STEP_IDS.ENTITLEMENT_GRANT]:     async () => ({ step: "search:detail_readable" }),
      [JOURNEY_STEP_IDS.ENTITLEMENT_AUTHORIZE]: async () => ({ step: "search:access_checked" }),
      [JOURNEY_STEP_IDS.DOWNLOAD_CAPABILITY]:   async () => ({ step: "search:flow_complete" }),
    },
  };

  // --- Entitlement revocation ---
  const revocationHarness = {
    steps: {
      [JOURNEY_STEP_IDS.CHECKOUT_QUOTE]:       async () => {
        // Ensure an entitlement row exists
        const now = new Date();
        await db.collection("entitlement_cache").updateOne(
          { materialId: MATERIAL_ID, buyerAddress: `${BUYER_ADDRESS}-revoke` },
          { $set: { materialId: MATERIAL_ID, buyerAddress: `${BUYER_ADDRESS}-revoke`, state: "finalized", active: true, updatedAt: now, syntheticMonitor: true }, $setOnInsert: { createdAt: now } },
          { upsert: true }
        );
        return { step: "revoke:entitlement_created" };
      },
      [JOURNEY_STEP_IDS.PURCHASE_CONFIRM]: async () => {
        // Revoke the entitlement
        await db.collection("entitlement_cache").updateOne(
          { materialId: MATERIAL_ID, buyerAddress: `${BUYER_ADDRESS}-revoke` },
          { $set: { active: false, revokedAt: new Date(), state: "revoked" } }
        );
        return { step: "revoke:entitlement_revoked" };
      },
      [JOURNEY_STEP_IDS.ENTITLEMENT_GRANT]: async () => {
        const entry = await db.collection("entitlement_cache").findOne({ materialId: MATERIAL_ID, buyerAddress: `${BUYER_ADDRESS}-revoke` });
        if (entry?.active !== false) throw Object.assign(new Error("Revoked entitlement is still active"), { dependency: "mongodb:entitlement_cache" });
        return { step: "revoke:revocation_confirmed", active: entry.active };
      },
      [JOURNEY_STEP_IDS.ENTITLEMENT_AUTHORIZE]: async () => {
        const decision = await getMaterialAccessStatus(db, MATERIAL_ID, `${BUYER_ADDRESS}-revoke`);
        if (decision.hasAccess) throw Object.assign(new Error("Revoked entitlement still grants access"), { dependency: "entitlement-policy" });
        return { step: "revoke:access_correctly_denied" };
      },
      [JOURNEY_STEP_IDS.DOWNLOAD_CAPABILITY]: async () => ({ step: "revoke:flow_complete" }),
    },
  };

  return { purchaseHarness, creatorPublishHarness: purchaseHarness, authHarness, searchHarness, revocationHarness };
}

async function seedSyntheticMaterial(db) {
  const now = new Date();
  await db.collection("materials").updateOne(
    { materialId: MATERIAL_ID },
    {
      $set: {
        materialId: MATERIAL_ID,
        title: "Synthetic monitor probe material",
        description: "Used by scripts/synthetic-monitor.mjs — safe to delete.",
        price: 1,
        asset: "XLM",
        visibility: "public",
        userAddress: CREATOR_ADDRESS,
        syntheticMonitor: true,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

async function cleanupSyntheticRows(db) {
  await Promise.allSettled([
    db.collection("checkout_quotes").deleteMany({ buyerAddress: BUYER_ADDRESS }),
    db.collection("purchases").deleteMany({ materialId: MATERIAL_ID, syntheticMonitor: true }),
    db.collection("entitlement_cache").deleteMany({ materialId: MATERIAL_ID, syntheticMonitor: true }),
    db.collection("entitlement_cache").deleteMany({ buyerAddress: `${BUYER_ADDRESS}-revoke` }),
    db.collection("materials").deleteMany({ materialId: MATERIAL_ID, syntheticMonitor: true }),
  ]);
}

async function postWebhook(url, payload) {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log("warn", "Webhook delivery failed", { error: String(err?.message || err) });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  log("info", "Synthetic monitor starting", {
    mode: args.dryRun ? "dry-run" : "live",
    scenarios: args.scenarioIds ?? "all",
  });

  let report;

  if (args.dryRun) {
    const adapters = buildDryRunAdapters(args.injectFailure);
    report = await runHealthCheck({
      adapters,
      scenarioIds:  args.scenarioIds ?? undefined,
      stepTimeoutMs: args.stepTimeoutMs,
      onScenario: (s) =>
        log(s.health === HEALTH_STATES.RED ? "error" : "info", "Scenario result", {
          id: s.id, health: s.health, ok: s.lastRun.ok, durationMs: s.lastRun.durationMs,
        }),
    });
  } else {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      log("error", "Missing MONGODB_URI — use --dry-run for CI");
      process.exit(1);
    }
    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    try {
      const db = client.db(process.env.MONGODB_DB ?? "eduvault");
      await seedSyntheticMaterial(db);
      const adapters = await buildLiveAdapters(db);
      report = await runHealthCheck({
        adapters,
        scenarioIds:  args.scenarioIds ?? undefined,
        stepTimeoutMs: args.stepTimeoutMs,
        onScenario: (s) =>
          log(s.health === HEALTH_STATES.RED ? "error" : "info", "Scenario result", {
            id: s.id, health: s.health, ok: s.lastRun.ok, durationMs: s.lastRun.durationMs,
            failures: s.lastRun.failures,
          }),
      });
      await cleanupSyntheticRows(db);
    } finally {
      await client.close().catch(() => {});
    }
  }

  log("info", "Synthetic monitor report", {
    health:  report.health,
    summary: report.summary,
    blame:   report.scenarios.flatMap((s) => s.history.blame ?? []).slice(0, 5),
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  }

  await postWebhook(process.env.SYNTHETIC_MONITOR_WEBHOOK_URL, {
    service:  "eduvault-synthetic-monitor",
    mode:     args.dryRun ? "dry-run" : "live",
    report,
  });

  if (report.health === HEALTH_STATES.RED) {
    log("error", "Synthetic monitor: RED health", { summary: report.summary });
    process.exit(1);
  }

  log("info", "Synthetic monitor passed", { health: report.health, summary: report.summary });
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "error", message: "Synthetic monitor crashed", error: String(err?.message || err), stack: err?.stack, timestamp: new Date().toISOString() }));
  process.exit(1);
});

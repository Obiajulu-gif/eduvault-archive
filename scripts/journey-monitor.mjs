#!/usr/bin/env node
/**
 * Synthetic journey monitor CLI — see docs/journey-monitor.md.
 *
 * Runs the critical end-to-end workflow (quote → purchase → entitlement →
 * authorized access → download capability) against a real database, or
 * `--dry-run` for CI wiring verification without Mongo. Reports per-step
 * latency, failures, and dependency blame; exits non-zero when the run fails
 * so a cron/GitHub Actions schedule pages the on-call operator.
 *
 * Usage:
 *   MONGODB_URI="$URI" node scripts/journey-monitor.mjs [--runs=3]
 *   node scripts/journey-monitor.mjs --dry-run [--inject-failure=checkout_quote]
 *
 * Environment:
 *   MONGODB_URI                    — required for live runs
 *   MONGODB_DB                     — database name (default: eduvault)
 *   JOURNEY_MONITOR_WEBHOOK_URL    — optional JSON webhook for the summary
 *   JOURNEY_MONITOR_STEP_TIMEOUT_MS— per-step timeout (default 15000)
 *   JOURNEY_MONITOR_RUNS           — default number of runs (default 1)
 *   JOURNEY_MONITOR_MAX_FAILURES   — allowed failed runs before exit 1 (default 0)
 */

import { MongoClient } from "mongodb";
import {
  JOURNEY_DEFINITION,
  JOURNEY_STEP_IDS,
  newJourneyRunId,
  runSyntheticJourney,
  summarizeJourneyReports,
} from "../src/lib/monitoring/journeyMonitor.js";

const MATERIAL_ID = "journey-monitor-material";
const BUYER_ADDRESS = "journey-monitor-buyer";
const CREATOR_ADDRESS = "journey-monitor-creator";

function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

function parseArgs(argv) {
  const args = {
    dryRun: argv.includes("--dry-run"),
    runs: Number(process.env.JOURNEY_MONITOR_RUNS || 1),
    maxFailures: Number(process.env.JOURNEY_MONITOR_MAX_FAILURES || 0),
    stepTimeoutMs: Number(process.env.JOURNEY_MONITOR_STEP_TIMEOUT_MS || 15_000),
    injectFailure: null,
    json: argv.includes("--json"),
  };
  for (const arg of argv) {
    if (arg.startsWith("--runs=")) args.runs = Number(arg.slice("--runs=".length));
    if (arg.startsWith("--max-failures=")) args.maxFailures = Number(arg.slice("--max-failures=".length));
    if (arg.startsWith("--inject-failure=")) args.injectFailure = arg.slice("--inject-failure=".length);
    if (arg.startsWith("--step-timeout-ms=")) args.stepTimeoutMs = Number(arg.slice("--step-timeout-ms=".length));
  }
  if (!Number.isSafeInteger(args.runs) || args.runs < 1) args.runs = 1;
  return args;
}

/**
 * Deterministic, dependency-free harness used by --dry-run: proves the
 * orchestration, timeout, blame, and reporting wiring without any I/O.
 */
function buildDryRunHarness(injectFailure = null) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const latencies = {
    [JOURNEY_STEP_IDS.CHECKOUT_QUOTE]: 5,
    [JOURNEY_STEP_IDS.PURCHASE_CONFIRM]: 12,
    [JOURNEY_STEP_IDS.ENTITLEMENT_GRANT]: 4,
    [JOURNEY_STEP_IDS.ENTITLEMENT_AUTHORIZE]: 3,
    [JOURNEY_STEP_IDS.DOWNLOAD_CAPABILITY]: 2,
  };
  const steps = {};
  for (const definition of JOURNEY_DEFINITION) {
    steps[definition.id] = async () => {
      await sleep(latencies[definition.id] || 1);
      if (injectFailure === definition.id) {
        const error = new Error(`Injected dry-run failure at ${definition.id}`);
        error.code = "dry_run_injected_failure";
        throw error;
      }
      return { dryRun: true, step: definition.id };
    };
  }
  return { steps };
}

/** Live harness using the real checkout/entitlement/download modules. */
async function buildLiveHarness({ db, entitlementWriter }) {
  const { createCheckoutQuote, consumeCheckoutQuote } = await import("../src/lib/checkout/quotes.js");
  const { getMaterialAccessStatus } = await import("../src/lib/purchases/access.js");
  const { generateCapabilityToken, verifyCapabilityToken } = await import("../src/lib/downloads/capabilityToken.js");

  const steps = {
    [JOURNEY_STEP_IDS.CHECKOUT_QUOTE]: async () => {
      const quote = await createCheckoutQuote(db, { materialId: MATERIAL_ID, buyerAddress: BUYER_ADDRESS });
      return { quoteId: quote.quoteId, price: quote.terms.price, asset: quote.terms.asset, expiresAt: quote.expiresAt };
    },

    [JOURNEY_STEP_IDS.PURCHASE_CONFIRM]: async ({ results }) => {
      const quoteId = results[JOURNEY_STEP_IDS.CHECKOUT_QUOTE]?.quoteId;
      if (!quoteId) throw new Error("Missing checkout quote from previous step");
      const quote = await consumeCheckoutQuote(db, { quoteId, materialId: MATERIAL_ID, buyerAddress: BUYER_ADDRESS });
      const now = new Date();
      const purchaseId = `journey-monitor-purchase-${quoteId}`;
      await db.collection("purchases").updateOne(
        { materialId: MATERIAL_ID, buyerAddress: BUYER_ADDRESS },
        {
          $set: {
            materialId: MATERIAL_ID,
            buyerAddress: BUYER_ADDRESS,
            purchaseId,
            status: "confirmed",
            transactionHash: `journey-monitor-tx-${quoteId}`,
            amount: quote.terms.price,
            asset: quote.terms.asset,
            purchasedAt: now,
            confirmedAt: now,
            updatedAt: now,
            syntheticMonitor: true,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
      // Exercise the real entitlement write path (same call the purchase route
      // makes). Deterministic purchaseId keeps authorization cache-backed.
      const entitlement = await entitlementWriter(MATERIAL_ID, BUYER_ADDRESS, {
        purchaseId,
        transactionHash: `journey-monitor-tx-${quoteId}`,
      });
      return { purchaseId, entitlementSource: entitlement?.source || null };
    },

    [JOURNEY_STEP_IDS.ENTITLEMENT_GRANT]: async () => {
      const entry = await db.collection("entitlement_cache").findOne({ materialId: MATERIAL_ID, buyerAddress: BUYER_ADDRESS });
      if (!entry) throw new Error("entitlement_cache row was not written for the synthetic purchase");
      const allowing = entry.active !== false && ["provisional", "finalized"].includes(String(entry.state));
      if (!allowing) {
        const error = new Error(`Entitlement cache is not allowing access (state=${entry.state}, active=${entry.active})`);
        error.dependency = "mongodb:entitlement_cache";
        error.retryable = false;
        throw error;
      }
      return { state: entry.state, active: entry.active, source: entry.source || null };
    },

    [JOURNEY_STEP_IDS.ENTITLEMENT_AUTHORIZE]: async ({ results }) => {
      const purchaseId = results[JOURNEY_STEP_IDS.PURCHASE_CONFIRM]?.purchaseId || null;
      const decision = await getMaterialAccessStatus(db, MATERIAL_ID, BUYER_ADDRESS);
      if (!decision.hasAccess || !decision.accessGranted) {
        const error = new Error(
          `Authorized access denied (status=${decision.status}, source=${decision.source}, purchaseStatus=${decision.purchaseStatus || "n/a"})`,
        );
        error.dependency = "entitlement-policy";
        error.retryable = false;
        throw error;
      }
      return { status: decision.status, source: decision.source, purchaseId };
    },

    [JOURNEY_STEP_IDS.DOWNLOAD_CAPABILITY]: async () => {
      const { token, payload } = generateCapabilityToken({
        buyer: BUYER_ADDRESS,
        material: MATERIAL_ID,
        byteRangeStart: 0,
        byteRangeEnd: 1023,
      });
      const verification = verifyCapabilityToken(token, { buyerAddress: BUYER_ADDRESS, materialId: MATERIAL_ID });
      if (!verification.valid) {
        const error = new Error(`Capability self-verification failed: ${verification.reason}`);
        error.dependency = "download-capability";
        error.retryable = false;
        throw error;
      }
      // Tampering with the buyer binding must be rejected (negative invariant).
      const tampered = verifyCapabilityToken(token, { buyerAddress: "someone-else", materialId: MATERIAL_ID });
      if (tampered.valid) {
        const error = new Error("Capability verification accepted a mismatched buyer (binding broken)");
        error.dependency = "download-capability";
        error.retryable = false;
        throw error;
      }
      return { capabilityId: payload.jti, expiresAtMs: payload.exp };
    },
  };

  return { steps };
}

async function seedSyntheticMaterial(db) {
  const now = new Date();
  await db.collection("materials").updateOne(
    { materialId: MATERIAL_ID },
    {
      $set: {
        materialId: MATERIAL_ID,
        title: "Journey monitor synthetic material",
        description: "Synthetic probe material used by scripts/journey-monitor.mjs. Safe to delete.",
        price: 1,
        asset: "XLM",
        visibility: "public",
        userAddress: CREATOR_ADDRESS,
        version: 1,
        updatedAt: now,
        syntheticMonitor: true,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

async function cleanupSyntheticRows(db) {
  const results = await Promise.allSettled([
    db.collection("checkout_quotes").deleteMany({ buyerAddress: BUYER_ADDRESS }),
    db.collection("purchases").deleteMany({ materialId: MATERIAL_ID, buyerAddress: BUYER_ADDRESS }),
    db.collection("entitlement_cache").deleteMany({ materialId: MATERIAL_ID, buyerAddress: BUYER_ADDRESS }),
    db.collection("materials").deleteMany({ materialId: MATERIAL_ID, syntheticMonitor: true }),
  ]);
  const errors = results.filter((result) => result.status === "rejected").map((result) => String(result.reason?.message || result.reason));
  return { ok: errors.length === 0, errors };
}

async function postWebhook(url, payload) {
  if (!url) return { skipped: true };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runReports = [];

  log("info", "Journey monitor starting", {
    mode: args.dryRun ? "dry-run" : "live",
    runs: args.runs,
    steps: JOURNEY_DEFINITION.map((step) => step.id),
  });

  if (args.dryRun) {
    const harness = buildDryRunHarness(args.injectFailure);
    for (let index = 0; index < args.runs; index += 1) {
      runReports.push(await runSyntheticJourney({ harness, runId: newJourneyRunId(), stepTimeoutMs: args.stepTimeoutMs }));
    }
  } else {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      log("error", "Missing required MONGODB_URI for a live journey monitor run (use --dry-run for CI)");
      process.exit(1);
    }
    const dbName = process.env.MONGODB_DB || "eduvault";
    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    try {
      const db = client.db(dbName);
      const { createEntitlement } = await import("../src/lib/entitlement.js");
      await seedSyntheticMaterial(db);
      const harness = await buildLiveHarness({ db, entitlementWriter: createEntitlement });

      for (let index = 0; index < args.runs; index += 1) {
        const report = await runSyntheticJourney({
          harness,
          runId: newJourneyRunId(),
          stepTimeoutMs: args.stepTimeoutMs,
          onStep: (step) =>
            log(step.status === "failed" ? "error" : "info", "Journey step", {
              stepId: step.id,
              status: step.status,
              durationMs: step.durationMs,
              dependency: step.dependency,
              ...(step.error ? { blame: step.error.dependency, code: step.error.code, message: step.error.message } : {}),
            }),
        });
        runReports.push(report);
      }

      const cleanup = await cleanupSyntheticRows(db);
      for (const report of runReports) report.cleanup = cleanup;
      if (!cleanup.ok) log("warn", "Synthetic row cleanup reported errors", cleanup);
    } finally {
      await client.close().catch(() => {});
    }
  }

  const summary = summarizeJourneyReports(runReports);
  const failedRuns = runReports.filter((report) => !report.ok);
  for (const report of failedRuns) {
    log("error", "Journey run failed", {
      runId: report.runId,
      durationMs: report.durationMs,
      blame: report.blame,
      failures: report.failures,
    });
  }
  log("info", "Journey monitor summary", { ...summary, maxFailures: args.maxFailures });

  await postWebhook(process.env.JOURNEY_MONITOR_WEBHOOK_URL, {
    service: "eduvault-journey-monitor",
    mode: args.dryRun ? "dry-run" : "live",
    summary,
    failedRuns: failedRuns.slice(0, 5).map((report) => ({ runId: report.runId, blame: report.blame, failures: report.failures })),
  });

  if (summary.failed > args.maxFailures) {
    log("error", "Journey monitor FAILED", { failed: summary.failed, maxFailures: args.maxFailures, blame: summary.blame });
    process.exit(1);
  }

  log("info", "Journey monitor passed", { runs: summary.runs, successRate: summary.successRate });
}

main().catch((error) => {
  log("error", "Journey monitor crashed", { error: String(error?.message || error), stack: error?.stack });
  process.exit(1);
});

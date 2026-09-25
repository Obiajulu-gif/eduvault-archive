#!/usr/bin/env node
/**
 * Deploy the EduVault Soroban contracts to a Stellar network (#412).
 *
 * What it does (in order):
 *   1. (optional) Builds both contracts to WASM via `stellar contract build`.
 *   2. Deploys `material_registry.wasm` and `purchase_manager.wasm` with
 *      `stellar contract deploy`, capturing each contract ID.
 *   3. Initialises the PurchaseManager via `stellar contract invoke ... initialize`
 *      with admin / registry / treasury / platform_fee_bps. (MaterialRegistry has
 *      no `initialize` entry point — its admin is bootstrapped lazily via
 *      `set_upgrade_admin`, done best-effort here when SOROBAN_ADMIN is set.)
 *   4. Writes the resulting contract IDs to a manifest at
 *      `soroban/deployments/<network>.json` and prints the `.env` lines to copy.
 *
 * This script shells out to the `stellar` CLI (>= 21) and therefore requires a
 * working Rust toolchain + `wasm32-unknown-unknown` target for the build step.
 *
 * ------------------------------------------------------------------------------
 * WHAT A HUMAN OPERATOR MUST STILL DO MANUALLY (this script cannot do it):
 *   - Install the Stellar CLI:  cargo install --locked stellar-cli
 *   - Create & fund a deployer identity on testnet:
 *       stellar keys generate deployer --network testnet
 *       stellar keys fund deployer --network testnet   (uses Friendbot)
 *   - Export the required env vars below.
 *   - Actually run this script in an environment with a working linker/toolchain.
 *     (It was authored but NOT executed in CI here — see the repo's build notes.)
 * ------------------------------------------------------------------------------
 *
 * Usage:
 *   node scripts/deploy-soroban.mjs [--skip-build] [--network testnet]
 *
 * Environment variables:
 *   STELLAR_NETWORK        — network name (default "testnet"); or pass --network
 *   SOROBAN_DEPLOYER       — required; `stellar` CLI identity name OR a secret key
 *                            (S...) used as --source for deploy/invoke
 *   SOROBAN_ADMIN          — required; admin Address (G...) for contract config
 *   SOROBAN_TREASURY       — required; platform fee recipient Address (G...)
 *   SOROBAN_PLATFORM_FEE_BPS — optional; platform fee in basis points (default 250)
 *   NEXT_PUBLIC_STELLAR_RPC_URL — optional; recorded in the manifest for reference
 *
 * Exit codes: 0 on success, 1 on any failure (missing env, CLI error, etc.).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildManifest,
  serializeManifest,
  manifestToEnvVars,
  manifestPathFor,
} from "./lib/soroban-manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SOROBAN_DIR = resolve(REPO_ROOT, "soroban");
const WASM_DIR = resolve(
  SOROBAN_DIR,
  "target/wasm32-unknown-unknown/release",
);

const WASM = {
  materialRegistry: resolve(WASM_DIR, "material_registry.wasm"),
  purchaseManager: resolve(WASM_DIR, "purchase_manager.wasm"),
};

function parseArgs(argv) {
  const args = { skipBuild: false, network: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--skip-build") args.skipBuild = true;
    else if (a === "--network") args.network = argv[++i];
  }
  return args;
}

function fail(message) {
  console.error(`[deploy-soroban] ERROR: ${message}`);
  process.exit(1);
}

/** Run a command, streaming output. Returns trimmed stdout. Throws on failure. */
function run(cmd, cmdArgs, opts = {}) {
  console.log(`[deploy-soroban] $ ${cmd} ${cmdArgs.join(" ")}`);
  const res = spawnSync(cmd, cmdArgs, {
    encoding: "utf8",
    stdio: opts.capture ? ["inherit", "pipe", "inherit"] : "inherit",
    cwd: opts.cwd || REPO_ROOT,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} exited with status ${res.status}`);
  }
  return (res.stdout || "").trim();
}

function requireEnv(name) {
  const val = process.env[name];
  if (!val) fail(`missing required env var ${name}`);
  return val;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const network = args.network || process.env.STELLAR_NETWORK || "testnet";
  const deployer = requireEnv("SOROBAN_DEPLOYER");
  const admin = requireEnv("SOROBAN_ADMIN");
  const treasury = requireEnv("SOROBAN_TREASURY");
  const platformFeeBps = Number(process.env.SOROBAN_PLATFORM_FEE_BPS || "250");
  const rpcUrl = process.env.NEXT_PUBLIC_STELLAR_RPC_URL || undefined;

  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0) {
    fail("SOROBAN_PLATFORM_FEE_BPS must be a non-negative integer");
  }

  // Ensure the stellar CLI is present before doing anything else.
  try {
    run("stellar", ["--version"], { capture: true });
  } catch {
    fail(
      "the `stellar` CLI was not found on PATH. Install it with " +
        "`cargo install --locked stellar-cli` (see docs/deployment.md).",
    );
  }

  // 1. Build (optional — requires a working Rust toolchain + wasm target).
  if (!args.skipBuild) {
    console.log("[deploy-soroban] Building contracts to WASM...");
    run("stellar", ["contract", "build"], { cwd: SOROBAN_DIR });
  } else {
    console.log("[deploy-soroban] --skip-build set; using existing WASM files.");
  }

  // 2. Deploy both contracts.
  const commonSource = ["--source", deployer, "--network", network];

  console.log("[deploy-soroban] Deploying MaterialRegistry...");
  const materialRegistryId = run(
    "stellar",
    ["contract", "deploy", "--wasm", WASM.materialRegistry, ...commonSource],
    { capture: true },
  );
  if (!materialRegistryId) fail("MaterialRegistry deploy returned no contract ID");
  console.log(`[deploy-soroban] MaterialRegistry -> ${materialRegistryId}`);

  console.log("[deploy-soroban] Deploying PurchaseManager...");
  const purchaseManagerId = run(
    "stellar",
    ["contract", "deploy", "--wasm", WASM.purchaseManager, ...commonSource],
    { capture: true },
  );
  if (!purchaseManagerId) fail("PurchaseManager deploy returned no contract ID");
  console.log(`[deploy-soroban] PurchaseManager -> ${purchaseManagerId}`);

  // 3. Initialise PurchaseManager (admin must authorise; --source signs).
  console.log("[deploy-soroban] Initialising PurchaseManager...");
  run("stellar", [
    "contract",
    "invoke",
    "--id",
    purchaseManagerId,
    ...commonSource,
    "--",
    "initialize",
    "--admin",
    admin,
    "--registry",
    materialRegistryId,
    "--treasury",
    treasury,
    "--platform_fee_bps",
    String(platformFeeBps),
  ]);

  // 3b. Best-effort MaterialRegistry upgrade-admin bootstrap. MaterialRegistry
  // has no initialize; set_upgrade_admin sets who may later `upgrade` it. This
  // is optional and may no-op/fail if the admin model differs — don't hard-fail.
  try {
    console.log("[deploy-soroban] Setting MaterialRegistry upgrade admin (best effort)...");
    run("stellar", [
      "contract",
      "invoke",
      "--id",
      materialRegistryId,
      ...commonSource,
      "--",
      "set_upgrade_admin",
      "--current_admin",
      admin,
      "--next_admin",
      admin,
    ]);
  } catch (err) {
    console.warn(
      `[deploy-soroban] WARN: set_upgrade_admin failed (${err.message}). ` +
        "This is non-fatal — set it manually if you need contract upgrades.",
    );
  }

  // 4. Write the manifest.
  const manifest = buildManifest({
    network,
    materialRegistryId,
    purchaseManagerId,
    admin,
    treasury,
    platformFeeBps,
    deployer,
    rpcUrl,
  });
  const manifestPath = resolve(REPO_ROOT, manifestPathFor(network));
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, serializeManifest(manifest));
  console.log(`[deploy-soroban] Wrote manifest -> ${manifestPath}`);

  console.log("\n[deploy-soroban] Add these to your .env.local / Vercel env:");
  for (const [k, v] of Object.entries(manifestToEnvVars(manifest))) {
    console.log(`${k}=${v}`);
  }
  console.log("\n[deploy-soroban] Done.");
}

main();

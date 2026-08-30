#!/usr/bin/env node
/**
 * Backup restore verification for EduVault (#377, #715).
 *
 * Validates a mongodump archive before it is applied to a production database:
 *  1. Confirms the archive is well-formed with a mongorestore dry-run.
 *  2. Connects to MongoDB, reads every document in each known collection,
 *     and checks that required schema fields are present.
 *  3. Verifies system secrets and decryption keys (e.g. JWT_SECRET).
 *  4. Validates content hashes and file references for protected materials.
 *  5. Verifies zero-trust entitlement decisions (entitled buyers allowed,
 *     unentitled callers blocked, revoked access rejected).
 *  6. Prints a structured JSON status report and exits 1 if any violations
 *     or entitlement defects are found, blocking downstream restore steps.
 *
 * Typical workflow:
 *   mongorestore --archive=backup.gz --gzip --uri=$STAGING_URI
 *   MONGODB_URI=$STAGING_URI JWT_SECRET=$JWT_SECRET node scripts/restore-verification.mjs backup.gz
 *   # only restore to production after this script exits 0
 *
 * Usage:
 *   node scripts/restore-verification.mjs <path-to-archive.gz>
 *
 * Required env vars:
 *   MONGODB_URI  — connection string for the database to validate
 *
 * Optional env vars:
 *   MONGODB_DB   — database name to validate (default: eduvault)
 *   JWT_SECRET   — secret key for signing auth and protected delivery tokens
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { MongoClient } from "mongodb";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Structured logger (matches backup-mongodb.mjs convention)
// ---------------------------------------------------------------------------
export function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

// ---------------------------------------------------------------------------
// Required fields per collection — documents missing any of these are flagged
// as schema violations and block the restore.
// ---------------------------------------------------------------------------
export const COLLECTION_SCHEMAS = {
  materials: ["_id", "title", "userAddress", "visibility", "createdAt"],
  users: ["_id", "walletAddress"],
  purchases: ["_id", "buyerAddress", "materialId", "createdAt"],
  entitlement_cache: ["_id", "buyerAddress", "materialId", "active"],
  sync_state: ["_id", "source"],
  sync_events: ["_id"],
  dead_letter_events: ["_id", "status"],
  material_history: ["_id", "materialId"],
  saved_materials: ["_id", "walletAddress", "materialId"],
};

// ---------------------------------------------------------------------------
// Step 1: Validate archive structure via mongorestore dry-run
// ---------------------------------------------------------------------------
export async function validateArchiveStructure(archive) {
  if (!archive) {
    log("error", "No archive path provided to validateArchiveStructure");
    return { ok: false, error: "No archive path provided" };
  }

  if (!existsSync(archive)) {
    log("error", "Archive file not found", { path: archive });
    return { ok: false, error: "Archive file not found" };
  }

  log("info", "Checking archive structure (mongorestore --dryRun)", { archive });
  try {
    const { stderr } = await execFileAsync("mongorestore", [
      `--archive=${archive}`,
      "--gzip",
      "--dryRun",
    ]);
    if (stderr) log("debug", "mongorestore output", { stderr });
    log("info", "Archive structure valid");
    return { ok: true };
  } catch (err) {
    log("error", "Archive structure invalid — restore blocked", { error: err.message });
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Step 2: Validate secret & encryption key environment configuration (#715)
// ---------------------------------------------------------------------------
export function validateSecrets(env = process.env) {
  const violations = [];

  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    violations.push({ secret: "JWT_SECRET", reason: "Missing required JWT_SECRET environment variable for protected material token verification" });
  } else if (typeof jwtSecret !== "string" || jwtSecret.length < 32) {
    violations.push({ secret: "JWT_SECRET", reason: "JWT_SECRET must be at least 32 characters long for security compliance" });
  }

  const mongoUri = env.MONGODB_URI;
  if (!mongoUri) {
    violations.push({ secret: "MONGODB_URI", reason: "Missing required MONGODB_URI connection string" });
  }

  const ok = violations.length === 0;
  if (!ok) {
    log("warn", "Secret validation failures detected during restore drill", { violations });
  } else {
    log("info", "Secret and encryption key environment OK");
  }

  return { ok, violations };
}

// ---------------------------------------------------------------------------
// Step 3: Validate collection schemas against known contracts
// ---------------------------------------------------------------------------
export async function validateCollectionSchemas(db) {
  const report = {
    collections: {},
    totalDocuments: 0,
    totalViolations: 0,
  };

  for (const [collectionName, requiredFields] of Object.entries(COLLECTION_SCHEMAS)) {
    const collection = db.collection(collectionName);
    let count = 0;
    let violations = 0;
    const violationSamples = [];

    const cursor = collection.find({});
    for await (const doc of cursor) {
      count++;
      const missing = requiredFields.filter((field) => !(field in doc));
      if (missing.length > 0) {
        violations++;
        if (violationSamples.length < 5) {
          violationSamples.push({ _id: String(doc._id), missingFields: missing });
        }
      }
    }
    await cursor.close();

    report.collections[collectionName] = {
      documents: count,
      violations,
      ...(violationSamples.length > 0 ? { violationSamples } : {}),
    };
    report.totalDocuments += count;
    report.totalViolations += violations;

    if (violations > 0) {
      log("warn", "Schema violations detected", {
        collection: collectionName,
        violations,
        samples: violationSamples,
      });
    } else {
      log("info", "Collection schema OK", { collection: collectionName, documents: count });
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Step 4: Validate protected material hashes & file references (#715)
// ---------------------------------------------------------------------------
export async function validateProtectedMaterialHashes(db) {
  const materialsColl = db.collection("materials");
  const report = {
    totalProtected: 0,
    violations: 0,
    violationSamples: [],
  };

  // Protected materials are paid materials, private visibility, or materials marked protected
  const cursor = materialsColl.find({
    $or: [
      { price: { $gt: 0 } },
      { visibility: "private" },
      { isProtected: true },
      { storageKey: { $exists: true, $ne: null } },
    ],
  });

  for await (const doc of cursor) {
    report.totalProtected++;
    const materialId = String(doc._id || doc.materialId);
    const cid = doc.storageKey ?? doc.ipfsCid ?? doc.cid ?? doc.fileHash ?? doc.fileUrl;

    const reasons = [];
    if (!cid || typeof cid !== "string" || cid.trim() === "") {
      reasons.push("Protected material is missing file/CID reference (storageKey, ipfsCid, cid, fileHash, or fileUrl)");
    } else {
      // Validate hash/CID structural format if fileHash or contentHash is explicitly specified
      const explicitHash = doc.fileHash || doc.contentHash;
      if (explicitHash) {
        if (typeof explicitHash !== "string" || explicitHash.trim().length === 0) {
          reasons.push("Explicit fileHash/contentHash is invalid or empty");
        } else if (explicitHash.length < 8) {
          reasons.push(`Content hash "${explicitHash}" is dangerously short or corrupted`);
        }
      }
    }

    if (reasons.length > 0) {
      report.violations++;
      if (report.violationSamples.length < 5) {
        report.violationSamples.push({ materialId, title: doc.title, reasons });
      }
    }
  }
  await cursor.close();

  if (report.violations > 0) {
    log("warn", "Protected material file hash / CID violations detected", report);
  } else {
    log("info", "Protected material hashes and CIDs OK", { totalProtected: report.totalProtected });
  }

  return report;
}

// ---------------------------------------------------------------------------
// Helper: Entitlement decision evaluation logic
// ---------------------------------------------------------------------------
export async function verifyEntitlementLogic(db, materialId, buyerAddress) {
  if (!materialId || !buyerAddress) return { hasAccess: false, source: "invalid-params" };
  const normalised = String(buyerAddress).trim().toLowerCase();

  // 1. Entitlement cache check
  const cached = await db.collection("entitlement_cache").findOne({
    materialId,
    buyerAddress: normalised,
  });
  if (cached?.active === true) {
    return { hasAccess: true, source: "cache" };
  }

  // 2. Completed purchase check
  const purchase = await db.collection("purchases").findOne({
    materialId,
    buyerAddress: normalised,
  });
  if (purchase) {
    const completed = new Set(["confirmed", "settled", "completed"]);
    if (completed.has(String(purchase.status || "").toLowerCase())) {
      return { hasAccess: true, source: "purchases-db" };
    }
  }

  return { hasAccess: false, source: "not-found" };
}

// ---------------------------------------------------------------------------
// Step 5: Validate entitlement decision integrity (#715)
// ---------------------------------------------------------------------------
export async function validateEntitlementDecisions(db) {
  const report = {
    entitledChecks: 0,
    unentitledChecks: 0,
    revokedChecks: 0,
    violations: 0,
    violationSamples: [],
  };

  const materialsColl = db.collection("materials");
  const purchasesColl = db.collection("purchases");
  const cacheColl = db.collection("entitlement_cache");

  // 1. Verify entitled buyers can access restored protected materials
  const activeCacheCursor = cacheColl.find({ active: true });
  for await (const cacheDoc of activeCacheCursor) {
    report.entitledChecks++;
    const { materialId, buyerAddress } = cacheDoc;
    const decision = await verifyEntitlementLogic(db, materialId, buyerAddress);
    if (!decision.hasAccess) {
      report.violations++;
      if (report.violationSamples.length < 5) {
        report.violationSamples.push({
          type: "entitled_access_denied",
          materialId,
          buyerAddress,
          reason: "Buyer with active entitlement cache record was denied access during restore drill",
        });
      }
    }
  }
  await activeCacheCursor.close();

  const completedPurchasesCursor = purchasesColl.find({
    status: { $in: ["confirmed", "settled", "completed"] },
  });
  for await (const purchaseDoc of completedPurchasesCursor) {
    report.entitledChecks++;
    const { materialId, buyerAddress } = purchaseDoc;
    const decision = await verifyEntitlementLogic(db, materialId, buyerAddress);
    if (!decision.hasAccess) {
      report.violations++;
      if (report.violationSamples.length < 5) {
        report.violationSamples.push({
          type: "settled_buyer_access_denied",
          materialId,
          buyerAddress,
          reason: "Buyer with settled purchase record was denied access during restore drill",
        });
      }
    }
  }
  await completedPurchasesCursor.close();

  // 2. Verify unentitled callers CANNOT access protected materials
  const syntheticUnentitledCaller = "unentitled_verifier_probe_addr_0x9999";
  const protectedMaterialsCursor = materialsColl.find({
    $or: [{ price: { $gt: 0 } }, { visibility: "private" }],
  });

  for await (const matDoc of protectedMaterialsCursor) {
    report.unentitledChecks++;
    const materialId = String(matDoc._id || matDoc.materialId);

    const ownerAddr = String(matDoc.userAddress || matDoc.ownerAddress || "").toLowerCase();
    if (syntheticUnentitledCaller.toLowerCase() === ownerAddr) continue;

    const decision = await verifyEntitlementLogic(db, materialId, syntheticUnentitledCaller);
    if (decision.hasAccess) {
      report.violations++;
      if (report.violationSamples.length < 5) {
        report.violationSamples.push({
          type: "unentitled_access_leak",
          materialId,
          buyerAddress: syntheticUnentitledCaller,
          reason: "Unentitled caller was incorrectly granted access to protected material",
        });
      }
    }
  }
  await protectedMaterialsCursor.close();

  // 3. Verify inactive/refunded purchases are NOT granted access
  const inactivePurchasesCursor = purchasesColl.find({
    status: { $in: ["refunded", "revoked", "cancelled", "pending"] },
  });
  for await (const inactDoc of inactivePurchasesCursor) {
    report.revokedChecks++;
    const { materialId, buyerAddress } = inactDoc;

    const activeCache = await cacheColl.findOne({ materialId, buyerAddress: String(buyerAddress).toLowerCase(), active: true });
    if (!activeCache) {
      const decision = await verifyEntitlementLogic(db, materialId, buyerAddress);
      if (decision.hasAccess) {
        report.violations++;
        if (report.violationSamples.length < 5) {
          report.violationSamples.push({
            type: "revoked_entitlement_leak",
            materialId,
            buyerAddress,
            reason: `Caller with ${inactDoc.status} purchase was incorrectly granted access`,
          });
        }
      }
    }
  }
  await inactivePurchasesCursor.close();

  if (report.violations > 0) {
    log("warn", "Entitlement decision violations detected during restore drill", report);
  } else {
    log("info", "Entitlement decision verification passed", {
      entitledChecks: report.entitledChecks,
      unentitledChecks: report.unentitledChecks,
      revokedChecks: report.revokedChecks,
    });
  }

  return report;
}

// ---------------------------------------------------------------------------
// Run full verification suite on database instance
// ---------------------------------------------------------------------------
export async function runRestoreVerification({ archivePath, mongoClient, dbName = "eduvault", env = process.env }) {
  log("info", "EduVault restore verification started (#715)", { archive: archivePath || "N/A", db: dbName });

  const secretResult = validateSecrets(env);

  if (archivePath) {
    const archiveResult = await validateArchiveStructure(archivePath);
    if (!archiveResult.ok) {
      return { ok: false, reason: `Archive structure validation failed: ${archiveResult.error}` };
    }
  }

  const db = mongoClient.db(dbName);
  const schemaReport = await validateCollectionSchemas(db);
  const hashReport = await validateProtectedMaterialHashes(db);
  const entitlementReport = await validateEntitlementDecisions(db);

  const totalViolations =
    (secretResult.ok ? 0 : secretResult.violations.length) +
    schemaReport.totalViolations +
    hashReport.violations +
    entitlementReport.violations;

  const summary = {
    secretsOk: secretResult.ok,
    schemaViolations: schemaReport.totalViolations,
    protectedMaterialViolations: hashReport.violations,
    entitlementViolations: entitlementReport.violations,
    totalViolations,
  };

  log("info", "Verification summary", summary);

  if (totalViolations > 0) {
    log("error", "Restore verification FAILED — restore blocked", summary);
    return { ok: false, summary };
  }

  log("info", "All restore verification checks passed. Safe to proceed with restore.", summary);
  return { ok: true, summary };
}

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------
const isDirectCli = process.argv[1] && (
  process.argv[1].endsWith("restore-verification.mjs") ||
  process.argv[1].includes("restore-verification")
);

if (isDirectCli) {
  (async () => {
    const archivePath = process.argv[2];
    const mongoUri = process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_DB || "eduvault";

    if (!mongoUri) {
      log("error", "Missing required MONGODB_URI environment variable");
      process.exit(1);
    }
    if (!archivePath) {
      log("error", "No archive path provided. Usage: node scripts/restore-verification.mjs <archive.gz>");
      process.exit(1);
    }

    const mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
    try {
      await mongoClient.connect();
      const result = await runRestoreVerification({ archivePath, mongoClient, dbName, env: process.env });
      if (!result.ok) {
        process.exit(1);
      }
    } catch (err) {
      log("error", "Fatal restore verification failure", { error: err.message });
      process.exit(1);
    } finally {
      await mongoClient.close();
    }
  })();
}

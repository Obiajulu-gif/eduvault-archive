/**
 * Data Export Service
 *
 * Collects all user-linked data from MongoDB, produces a versioned JSON
 * manifest, and stores it as a time-limited export record that the user
 * can download via a signed URL.
 *
 * Export lifecycle
 * ─────────────────
 *  1. createExportRequest(userId, walletAddress)
 *       → inserts a data_export_requests doc with status "pending"
 *       → returns { requestId }
 *
 *  2. generateExport(requestId)            ← called by background job
 *       → fetches every exportable collection
 *       → builds a versioned manifest
 *       → stores the manifest JSON in the data_export_requests doc
 *       → sets status "ready" and expiresAt = now + EXPORT_TTL_MS
 *
 *  3. getExportDownload(requestId, userId)
 *       → validates ownership + expiry
 *       → returns the manifest JSON payload (caller streams it)
 */

import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb.js";
import { exportableCollections } from "./retentionPolicy.js";

export const EXPORT_MANIFEST_VERSION = "1";
export const EXPORT_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

export const EXPORT_STATUS = Object.freeze({
  PENDING:    "pending",
  PROCESSING: "processing",
  READY:      "ready",
  EXPIRED:    "expired",
  FAILED:     "failed",
});

// ─── Internal helpers ──────────────────────────────────────────────────────

function normalizeUserId(userId) {
  return String(userId);
}

/**
 * Look up a user document by MongoDB _id or walletAddress.
 */
async function resolveUser(db, userId) {
  const users = db.collection("users");
  if (ObjectId.isValid(userId)) {
    const byId = await users.findOne({ _id: new ObjectId(userId) });
    if (byId) return byId;
  }
  return users.findOne({ walletAddress: userId });
}

/**
 * Collect all records from one collection that belong to this user.
 * Each collection may use a different ownership field.
 */
async function fetchCollectionData(db, collectionName, user) {
  const wAddr = user.walletAddress;
  const userId = normalizeUserId(user._id);

  // Per-collection ownership predicates
  const predicates = {
    users:             { _id: user._id },
    refresh_tokens:    { userId },
    materials:         { $or: [{ userAddress: wAddr }, { walletAddress: wAddr }] },
    saved_materials:   { walletAddress: wAddr },
    collections:       { $or: [{ creatorId: userId }, { walletAddress: wAddr }] },
    progress:          { userId },
    reviews:           { walletAddress: wAddr },
    purchases:         { buyerAddress: wAddr },
    entitlement_cache: { buyerAddress: wAddr },
    webhooks:          { userId },
  };

  const filter = predicates[collectionName];
  if (!filter) return [];

  try {
    const docs = await db.collection(collectionName).find(filter).toArray();
    return docs;
  } catch {
    return [];
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Create a pending export request.  Returns the new request document.
 */
export async function createExportRequest(userId) {
  const db = await getDb();

  // Rate-limit: one pending/ready export at a time per user
  const existing = await db.collection("data_export_requests").findOne({
    userId: normalizeUserId(userId),
    status: { $in: [EXPORT_STATUS.PENDING, EXPORT_STATUS.PROCESSING, EXPORT_STATUS.READY] },
  });
  if (existing) {
    return { alreadyExists: true, request: existing };
  }

  const doc = {
    userId: normalizeUserId(userId),
    status: EXPORT_STATUS.PENDING,
    token: crypto.randomBytes(32).toString("hex"),
    requestedAt: new Date(),
    expiresAt: null,
    completedAt: null,
    manifest: null,
    error: null,
  };

  const result = await db.collection("data_export_requests").insertOne(doc);
  return { alreadyExists: false, request: { ...doc, _id: result.insertedId } };
}

/**
 * Process a pending export request — intended to be called by a background
 * job or the API route directly for small accounts.
 */
export async function generateExport(requestId) {
  const db = await getDb();
  const col = db.collection("data_export_requests");

  // Claim the job atomically
  const claimed = await col.findOneAndUpdate(
    { _id: new ObjectId(requestId), status: EXPORT_STATUS.PENDING },
    { $set: { status: EXPORT_STATUS.PROCESSING, processingStartedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!claimed) throw new Error(`Export request ${requestId} not found or already processing`);

  const { userId } = claimed;

  try {
    const user = await resolveUser(db, userId);
    if (!user) throw new Error(`User ${userId} not found`);

    const collectibles = exportableCollections();
    const sections = {};

    for (const coll of collectibles) {
      sections[coll] = await fetchCollectionData(db, coll, user);
    }

    const manifest = {
      version:     EXPORT_MANIFEST_VERSION,
      generatedAt: new Date().toISOString(),
      userId:      normalizeUserId(user._id),
      walletAddress: user.walletAddress ?? null,
      email:         user.email ?? null,
      sections,
    };

    const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);

    await col.updateOne(
      { _id: new ObjectId(requestId) },
      {
        $set: {
          status:       EXPORT_STATUS.READY,
          manifest,
          completedAt:  new Date(),
          expiresAt,
          error:        null,
        },
      }
    );

    return { ok: true, expiresAt };
  } catch (err) {
    await col.updateOne(
      { _id: new ObjectId(requestId) },
      { $set: { status: EXPORT_STATUS.FAILED, error: err.message } }
    );
    throw err;
  }
}

/**
 * Retrieve a ready export, validating ownership and token.
 * Returns { manifest, expiresAt } or throws.
 */
export async function getExportDownload(requestId, userId, token) {
  const db = await getDb();
  const doc = await db.collection("data_export_requests").findOne({
    _id: new ObjectId(requestId),
  });

  if (!doc) throw Object.assign(new Error("Export not found"), { code: "not_found" });
  if (doc.userId !== normalizeUserId(userId)) {
    throw Object.assign(new Error("Forbidden"), { code: "forbidden" });
  }
  if (doc.token !== token) {
    throw Object.assign(new Error("Invalid token"), { code: "forbidden" });
  }
  if (doc.status !== EXPORT_STATUS.READY) {
    throw Object.assign(new Error(`Export status: ${doc.status}`), { code: "not_ready", status: doc.status });
  }
  if (doc.expiresAt && doc.expiresAt < new Date()) {
    // Mark as expired
    await db.collection("data_export_requests").updateOne(
      { _id: doc._id },
      { $set: { status: EXPORT_STATUS.EXPIRED } }
    );
    throw Object.assign(new Error("Export has expired"), { code: "expired" });
  }

  return { manifest: doc.manifest, expiresAt: doc.expiresAt };
}

/**
 * Get the current status of an export request (for polling).
 */
export async function getExportStatus(requestId, userId) {
  const db = await getDb();
  const doc = await db.collection("data_export_requests").findOne({
    _id: new ObjectId(requestId),
  });
  if (!doc) throw Object.assign(new Error("Not found"), { code: "not_found" });
  if (doc.userId !== normalizeUserId(userId)) {
    throw Object.assign(new Error("Forbidden"), { code: "forbidden" });
  }

  // Lazily mark expired
  if (doc.status === EXPORT_STATUS.READY && doc.expiresAt && doc.expiresAt < new Date()) {
    await db.collection("data_export_requests").updateOne(
      { _id: doc._id },
      { $set: { status: EXPORT_STATUS.EXPIRED } }
    );
    return { status: EXPORT_STATUS.EXPIRED };
  }

  return {
    status:       doc.status,
    requestedAt:  doc.requestedAt,
    completedAt:  doc.completedAt ?? null,
    expiresAt:    doc.expiresAt ?? null,
  };
}

/**
 * Ensure required indexes exist for the data_export_requests collection.
 */
export async function ensureExportIndexes(db) {
  const col = db.collection("data_export_requests");
  await col.createIndex({ userId: 1, status: 1 });
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

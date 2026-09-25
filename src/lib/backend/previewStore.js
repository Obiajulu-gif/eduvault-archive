/**
 * Storage for sandboxed preview descriptors (#638).
 *
 * Previews live in their own collection (`material_previews`), keyed by the
 * original file's content hash — never on the file's IPFS path, never in
 * `materials`, never assigned to `coverImageUrl`. State machine:
 *
 *   pending -> ready | failed | rejected
 *
 * Transitions are guarded (a terminal row is not re-opened), so replays from
 * the outbox lease-expiry path are idempotent — the same shape as
 * `finalizeQuarantine`.
 *
 * Time/space: O(1) per call — a single indexed upsert / findOne on
 * `{ contentHash }`.
 */

import { COLLECTIONS } from "./schemaContracts";

export const PREVIEW_STATES = Object.freeze({
  PENDING: "pending",
  READY: "ready",
  FAILED: "failed",
  REJECTED: "rejected",
});

const TERMINAL = new Set([PREVIEW_STATES.READY, PREVIEW_STATES.FAILED, PREVIEW_STATES.REJECTED]);

function collection(db) {
  return db.collection(COLLECTIONS.materialPreviews);
}

/**
 * Create (or leave untouched) the pending row for a content hash.
 * @returns {Promise<object>} the current row.
 */
export async function ensurePreviewRecord(db, { contentHash, materialId = null, mimeType = null, sizeBytes = null }) {
  if (!contentHash) throw new Error("ensurePreviewRecord: contentHash is required");
  const now = new Date();
  await collection(db).updateOne(
    { contentHash },
    {
      $setOnInsert: {
        contentHash,
        materialId: materialId || null,
        mimeType: mimeType || null,
        sizeBytes: sizeBytes ?? null,
        state: PREVIEW_STATES.PENDING,
        descriptor: null,
        previewerVersion: null,
        reason: null,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true },
  );
  return collection(db).findOne({ contentHash });
}

async function transition(db, contentHash, patch) {
  const now = new Date();
  const res = await collection(db).findOneAndUpdate(
    { contentHash, state: { $nin: [...TERMINAL] } },
    { $set: { ...patch, updatedAt: now }, $inc: { attemptCount: 1 } },
    { returnDocument: "after" },
  );
  return res?.value ?? null;
}

export function markReady(db, contentHash, descriptor, previewerVersion = null) {
  return transition(db, contentHash, {
    state: PREVIEW_STATES.READY,
    descriptor,
    previewerVersion,
    reason: null,
    generatedAt: new Date(),
  });
}

export function markFailed(db, contentHash, reason) {
  return transition(db, contentHash, { state: PREVIEW_STATES.FAILED, descriptor: null, reason: String(reason).slice(0, 500) });
}

export function markRejected(db, contentHash, reason) {
  return transition(db, contentHash, { state: PREVIEW_STATES.REJECTED, descriptor: null, reason: String(reason).slice(0, 500) });
}

/**
 * @returns {Promise<object|null>} the row, or null if none.
 */
export function getPreview(db, contentHash) {
  return collection(db).findOne({ contentHash });
}

/**
 * The publishable descriptor for a content hash, or null unless `state` is
 * `ready`. Callers must not fall back to the original file when this is null.
 */
export async function getReadyDescriptor(db, contentHash) {
  const row = await collection(db).findOne({ contentHash, state: PREVIEW_STATES.READY });
  return row?.descriptor ?? null;
}

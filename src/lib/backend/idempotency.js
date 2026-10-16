import crypto from "node:crypto";
import { AppError } from "@/lib/errors/AppError.js";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const IDEMPOTENCY_KEY_FIELD = "idempotencyKey";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_KEY_LENGTH = 128;

/**
 * Canonicalizes a payload for hashing so semantically identical requests
 * produce identical hashes regardless of key order or whitespace.
 */
function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function hashPayload(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
    .digest("hex");
}

/**
 * Extracts an idempotency key from a request header or body field.
 * Returns null when the caller did not supply one.
 */
export function extractIdempotencyKey(request) {
  if (request?.headers) {
    const headerValue = request.headers.get(IDEMPOTENCY_KEY_HEADER);
    if (headerValue && headerValue.trim()) {
      return headerValue.trim().slice(0, MAX_KEY_LENGTH);
    }
  }
  if (request?.body && typeof request.body === "object") {
    const bodyValue = request.body[IDEMPOTENCY_KEY_FIELD];
    if (typeof bodyValue === "string" && bodyValue.trim()) {
      return bodyValue.trim().slice(0, MAX_KEY_LENGTH);
    }
  }
  return null;
}

function idempotencyCollection(db) {
  return db.collection("idempotency_keys");
}

const DEFAULT_LOCK_MS = 2 * 60 * 1000; // how long an in-flight claim blocks duplicates
const MAX_CLAIM_ATTEMPTS = 5;

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

/**
 * Executes a high-risk write with idempotency protection.
 *
 * - The first caller atomically claims the key (insert of an `in_progress`
 *   record; the unique `_id` makes exactly one concurrent claim win), runs the
 *   handler once, and persists the outcome.
 * - Duplicate calls with the same key and payload after completion return the
 *   stored response without re-executing side effects.
 * - Duplicate calls while the first is still running are rejected with the
 *   retryable CONFLICT_IN_PROGRESS instead of running the handler a second time.
 * - Same key with a different payload is rejected with CONFLICT_IDEMPOTENCY_KEY.
 * - Failed outcomes can be retried with the same key.
 * - Expired keys (past TTL) and abandoned claims (owner crashed, lock expired)
 *   are taken over; the stale record is removed with a conditional delete so a
 *   slow actor can never delete a newer actor's claim.
 *
 * Trade-off: if a handler outlives `lockMs` another caller may take over and
 * run it again. Set `lockMs` above the handler's worst-case duration.
 *
 * @param {object} db - Database handle
 * @param {string} key - Idempotency key
 * @param {object} payload - Request payload (hashed for collision detection)
 * @param {Function} handler - Async function performing the write
 * @param {object} [options]
 * @param {number} [options.ttlMs] - Key retention window (default 24h)
 * @param {number} [options.lockMs] - In-flight claim lifetime (default 2m)
 * @param {() => Date} [options.clock] - Time source (tests)
 * @returns {Promise<{result: object, replayed: boolean}>}
 */
export async function withIdempotency(
  db,
  key,
  payload,
  handler,
  { ttlMs = DEFAULT_TTL_MS, lockMs = DEFAULT_LOCK_MS, clock = () => new Date() } = {}
) {
  if (!key) {
    const result = await handler();
    return { result, replayed: false };
  }

  const collection = idempotencyCollection(db);
  const payloadHash = hashPayload(payload);
  const claimId = crypto.randomUUID();

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const now = clock();
    try {
      await collection.insertOne({
        _id: key,
        claimId,
        status: "in_progress",
        payloadHash,
        createdAt: now,
        lockExpiresAt: new Date(now.getTime() + lockMs),
        expiresAt: new Date(now.getTime() + ttlMs),
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;

      const existing = await collection.findOne({ _id: key });
      if (!existing) continue; // released between our insert and read; claim again

      const removeStale = () => collection.deleteOne({ _id: key, claimId: existing.claimId });

      if (existing.expiresAt && existing.expiresAt < now) {
        await removeStale();
        continue;
      }
      if (existing.payloadHash !== payloadHash) {
        throw new AppError("CONFLICT_IDEMPOTENCY_KEY", { details: { idempotencyKey: key } });
      }
      if (existing.status === "completed") {
        return { result: existing.response, replayed: true };
      }
      if (existing.status === "failed") {
        await removeStale();
        continue;
      }
      if (existing.status === "in_progress" && existing.lockExpiresAt && existing.lockExpiresAt < now) {
        await removeStale(); // owner abandoned the claim
        continue;
      }
      throw new AppError("CONFLICT_IN_PROGRESS", { details: { idempotencyKey: key } });
    }

    // We own the claim.
    let result;
    try {
      result = await handler();
    } catch (error) {
      try {
        await collection.updateOne(
          { _id: key, claimId },
          { $set: { status: "failed", error: error.message?.slice(0, 500), failedAt: new Date() } }
        );
      } catch {
        // Bookkeeping must never mask the handler's own error; the lock
        // expiry will release the key.
      }
      throw error;
    }

    await collection.updateOne(
      { _id: key, claimId },
      { $set: { status: "completed", response: result, completedAt: new Date() } }
    );
    return { result, replayed: false };
  }

  // Could not claim or observe a stable record: treat as contention.
  throw new AppError("CONFLICT_IN_PROGRESS", { details: { idempotencyKey: key } });
}

/**
 * Returns the stored outcome for an idempotency key, or null if absent/expired.
 * Useful for read-only replay checks without executing a handler.
 */
export async function getIdempotencyOutcome(db, key) {
  if (!key) return null;
  const collection = idempotencyCollection(db);
  const existing = await collection.findOne({ _id: key });
  if (!existing) return null;
  if (existing.expiresAt && existing.expiresAt < new Date()) return null;
  return existing;
}

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

/**
 * Executes a high-risk write with idempotency protection.
 *
 * - First call with a key runs the handler and persists the outcome.
 * - Duplicate calls with the same key and same payload return the stored
 *   response without re-executing side effects.
 * - Duplicate calls with the same key but a different payload are rejected
 *   with CONFLICT_IDEMPOTENCY_KEY.
 * - Failed outcomes can be retried with the same key.
 * - Expired keys (past TTL) are treated as absent so clients can reuse them.
 *
 * @param {object} db - Database handle
 * @param {string} key - Idempotency key
 * @param {object} payload - Request payload (hashed for collision detection)
 * @param {Function} handler - Async function performing the write
 * @param {object} [options]
 * @param {number} [options.ttlMs] - Key retention window (default 24h)
 * @returns {Promise<{result: object, replayed: boolean}>}
 */
export async function withIdempotency(db, key, payload, handler, { ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!key) {
    const result = await handler();
    return { result, replayed: false };
  }

  const collection = idempotencyCollection(db);
  const payloadHash = hashPayload(payload);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  const existing = await collection.findOne({ _id: key });

  if (existing) {
    // Expired key — safe to reuse
    if (existing.expiresAt && existing.expiresAt < now) {
      await collection.deleteOne({ _id: key });
    } else {
      // Key collision: same key, different payload
      if (existing.payloadHash !== payloadHash) {
        throw new AppError("CONFLICT_IDEMPOTENCY_KEY", {
          details: { idempotencyKey: key },
        });
      }

      // Replay successful outcome
      if (existing.status === "completed") {
        return { result: existing.response, replayed: true };
      }

      // Failed outcome — allow retry by removing the stale record
      if (existing.status === "failed") {
        await collection.deleteOne({ _id: key });
      }
    }
  }

  try {
    const result = await handler();
    const response = result;
    await collection.insertOne({
      _id: key,
      status: "completed",
      payloadHash,
      response,
      createdAt: now,
      completedAt: new Date(),
      expiresAt,
    });
    return { result, replayed: false };
  } catch (error) {
    await collection.insertOne({
      _id: key,
      status: "failed",
      payloadHash,
      error: error.message?.slice(0, 500),
      createdAt: now,
      expiresAt,
    });
    throw error;
  }
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

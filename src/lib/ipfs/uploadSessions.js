import { createHash, randomUUID } from "node:crypto"

export const UPLOAD_STATES = ["created", "uploading", "ready", "completing", "complete", "cancelled", "cleanup_pending"]

export function validateUploadSpec(spec) {
  if (!spec?.fileName || !spec?.mimeType || !Number.isSafeInteger(spec?.size) || spec.size < 1) {
    throw new Error("fileName, mimeType and a positive integer size are required")
  }
  if (spec.size > 5 * 1024 * 1024 * 1024) throw new Error("file exceeds the 5GB session limit")
  if (!/^[a-f\d]{64}$/i.test(spec.sha256 || "")) throw new Error("sha256 must be a 64-character hex digest")
}

export function hashChunk(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

export async function ensureUploadIndexes(db) {
  const sessions = db.collection("upload_sessions")
  await Promise.all([
    sessions.createIndex({ ownerId: 1, idempotencyKey: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1, state: 1 }),
    db.collection("materials").createIndex({ uploadSessionId: 1 }, { unique: true, sparse: true }),
  ])
}

export async function createUploadSession(db, { ownerId, idempotencyKey, file, thumbnail }) {
  if (!ownerId || !idempotencyKey?.trim()) throw new Error("owner and Idempotency-Key are required")
  validateUploadSpec(file)
  if (thumbnail) validateUploadSpec(thumbnail)
  const now = new Date()
  const session = {
    _id: randomUUID(), ownerId, idempotencyKey: idempotencyKey.trim(),
    state: "created", file, thumbnail: thumbnail || null, parts: {}, pins: [],
    createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  }
  await ensureUploadIndexes(db)
  try {
    await db.collection("upload_sessions").insertOne(session)
    return session
  } catch (error) {
    if (error?.code !== 11000) throw error
    return db.collection("upload_sessions").findOne({ ownerId, idempotencyKey: idempotencyKey.trim() })
  }
}

export async function recordUploadedPart(db, { sessionId, ownerId, name, cid, sha256, size }) {
  if (!["file", "thumbnail", "metadata"].includes(name)) throw new Error("unknown upload part")
  if (!cid || !/^[a-f\d]{64}$/i.test(sha256 || "") || !Number.isSafeInteger(size) || size < 1) {
    throw new Error("cid, sha256 and size are required")
  }
  const session = await db.collection("upload_sessions").findOne({ _id: sessionId, ownerId })
  if (!session || !["created", "uploading", "ready"].includes(session.state)) throw new Error("upload session is not writable")
  const expected = name === "file" ? session.file : name === "thumbnail" ? session.thumbnail : null
  if (expected && (expected.sha256.toLowerCase() !== sha256.toLowerCase() || expected.size !== size)) {
    throw new Error(`${name} integrity check failed`)
  }
  const previous = session.parts?.[name]
  if (previous) {
    if (previous.cid === cid && previous.sha256 === sha256 && previous.size === size) return session
    throw new Error(`${name} was already uploaded with different content`)
  }
  const required = session.thumbnail ? ["file", "thumbnail"] : ["file"]
  const parts = { ...(session.parts || {}), [name]: { cid, sha256: sha256.toLowerCase(), size } }
  const state = required.every((part) => parts[part]) ? "ready" : "uploading"
  await db.collection("upload_sessions").updateOne(
    { _id: sessionId, ownerId, [`parts.${name}`]: { $exists: false }, state: { $in: ["created", "uploading", "ready"] } },
    { $set: { [`parts.${name}`]: parts[name], state, updatedAt: new Date() }, $addToSet: { pins: cid } }
  )
  return db.collection("upload_sessions").findOne({ _id: sessionId, ownerId })
}

export async function completeUploadSession(db, { sessionId, ownerId, material }) {
  const claimed = await db.collection("upload_sessions").findOneAndUpdate(
    { _id: sessionId, ownerId, state: "ready" },
    { $set: { state: "completing", updatedAt: new Date() } },
    { returnDocument: "after" }
  )
  if (!claimed) {
    const existing = await db.collection("materials").findOne({ uploadSessionId: sessionId, ownerId })
    if (existing) return existing
    throw new Error("upload session is not ready for completion")
  }
  try {
    const document = {
      ...material, ownerId, uploadSessionId: sessionId,
      storageKey: claimed.parts.file.cid,
      thumbnailStorageKey: claimed.parts.thumbnail?.cid || null,
      publishedAt: new Date(),
    }
    await db.collection("materials").updateOne(
      { uploadSessionId: sessionId, ownerId },
      { $setOnInsert: document },
      { upsert: true }
    )
    await db.collection("upload_sessions").updateOne(
      { _id: sessionId, ownerId, state: "completing" },
      { $set: { state: "complete", completedAt: new Date(), updatedAt: new Date() } }
    )
    return db.collection("materials").findOne({ uploadSessionId: sessionId, ownerId })
  } catch (error) {
    await db.collection("upload_sessions").updateOne(
      { _id: sessionId, ownerId, state: "completing" },
      { $set: { state: "cleanup_pending", lastError: String(error?.message || error), updatedAt: new Date() } }
    )
    throw error
  }
}

export async function cancelUploadSession(db, { sessionId, ownerId }) {
  const result = await db.collection("upload_sessions").findOneAndUpdate(
    { _id: sessionId, ownerId, state: { $in: ["created", "uploading", "ready", "cleanup_pending"] } },
    { $set: { state: "cleanup_pending", cancelledAt: new Date(), updatedAt: new Date() } },
    { returnDocument: "after" }
  )
  if (!result) throw new Error("session cannot be cancelled")
  return result
}

export async function reclaimUploadSessions(db, unpin, { now = new Date(), limit = 100 } = {}) {
  const sessions = await db.collection("upload_sessions").find({
    $or: [{ state: "cleanup_pending" }, { state: { $in: ["created", "uploading", "ready"] }, expiresAt: { $lte: now } }],
  }).sort({ updatedAt: 1 }).limit(Math.min(Math.max(limit, 1), 500)).toArray()
  let cleaned = 0
  for (const session of sessions) {
    try {
      for (const cid of session.pins || []) await unpin(cid)
      await db.collection("upload_sessions").updateOne(
        { _id: session._id, state: { $ne: "complete" } },
        { $set: { state: "cancelled", cleanedAt: new Date(), updatedAt: new Date() }, $unset: { lastError: "" } }
      )
      cleaned += 1
    } catch (error) {
      await db.collection("upload_sessions").updateOne(
        { _id: session._id }, { $set: { state: "cleanup_pending", lastError: String(error?.message || error), updatedAt: new Date() } }
      )
    }
  }
  return { scanned: sessions.length, cleaned }
}

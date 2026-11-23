import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

export const UPLOAD_SESSIONS_COLLECTION = 'upload_sessions';
export const UPLOAD_CHUNKS_COLLECTION = 'upload_chunks';

export const UPLOAD_STATE = Object.freeze({
  INITIALIZED: 'initialized',
  IN_PROGRESS: 'in_progress',
  PAUSED: 'paused',
  FAILED: 'failed',
  FINALIZED: 'finalized',
});

export const CHUNK_STATE = Object.freeze({
  UPLOADED: 'uploaded',
  VERIFIED: 'verified',
  FAILED: 'failed',
});

const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_CHUNK_SIZE = 16 * 1024 * 1024;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class ResumableUploadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResumableUploadError';
    this.code = code;
  }
}

export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function uploaderId(user) {
  if (typeof user === 'string') return user;
  return user?.walletAddress || user?.address || user?.id || user?.sub || null;
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function requireDb(db) {
  if (!db) throw new ResumableUploadError('DB_REQUIRED', 'Database connection required');
}

export function validateUploadMetadata({
  fileName,
  size,
  chunkSize = DEFAULT_CHUNK_SIZE,
  mimeType,
  expectedHash,
} = {}) {
  if (!fileName || typeof fileName !== 'string' || fileName.length > 512) {
    throw new ResumableUploadError('INVALID_FILE_NAME', 'A file name of at most 512 characters is required');
  }
  if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE_SIZE) {
    throw new ResumableUploadError('INVALID_FILE_SIZE', 'File size must be a positive integer within the upload limit');
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 1024 || chunkSize > MAX_CHUNK_SIZE) {
    throw new ResumableUploadError('INVALID_CHUNK_SIZE', 'Chunk size must be between 1 KiB and 16 MiB');
  }
  if (!mimeType || typeof mimeType !== 'string' || mimeType.length > 255) {
    throw new ResumableUploadError('INVALID_MIME_TYPE', 'A MIME type is required');
  }
  if (!/^[a-fA-F0-9]{64}$/.test(String(expectedHash || ''))) {
    throw new ResumableUploadError('INVALID_EXPECTED_HASH', 'A SHA-256 expectedHash is required');
  }
  return { fileName, size, chunkSize, mimeType, expectedHash: expectedHash.toLowerCase() };
}

export async function createUploadSession({ db, uploader, metadata, now = new Date() } = {}) {
  requireDb(db);
  const owner = uploaderId(uploader);
  if (!owner) throw new ResumableUploadError('UNAUTHORIZED_UPLOAD', 'An authenticated uploader is required');

  const validated = validateUploadMetadata(metadata);
  const sessionId = `session_${randomUUID()}`;
  const session = {
    _id: sessionId,
    uploadToken: randomUUID().replace(/-/g, ''),
    uploader: owner,
    fileName: validated.fileName,
    mimeType: validated.mimeType,
    totalBytes: validated.size,
    chunkSize: validated.chunkSize,
    totalChunks: Math.ceil(validated.size / validated.chunkSize),
    expectedHash: validated.expectedHash,
    state: UPLOAD_STATE.INITIALIZED,
    completedChunks: 0,
    uploadedBytes: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  };

  await db.collection(UPLOAD_SESSIONS_COLLECTION).insertOne(session);
  return session;
}

async function getSession(db, sessionId) {
  const session = await db.collection(UPLOAD_SESSIONS_COLLECTION).findOne({ _id: sessionId });
  if (!session) throw new ResumableUploadError('SESSION_NOT_FOUND', 'Upload session not found');
  return session;
}

async function authorizeSession({ db, sessionId, uploadToken, uploader }) {
  const session = await getSession(db, sessionId);
  const owner = uploaderId(uploader);
  if (!owner || session.uploader !== owner || !sameSecret(session.uploadToken, uploadToken)) {
    throw new ResumableUploadError('UNAUTHORIZED_UPLOAD', 'Upload token or owner mismatch');
  }
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    throw new ResumableUploadError('SESSION_EXPIRED', 'Upload session has expired');
  }
  return session;
}

function assertMutable(session) {
  if (session.state === UPLOAD_STATE.FINALIZED) {
    throw new ResumableUploadError('SESSION_FINALIZED', 'Upload session is already finalized');
  }
}

async function recomputeProgress(db, session, now) {
  const chunks = await db.collection(UPLOAD_CHUNKS_COLLECTION)
    .find({ sessionId: session._id, state: { $in: [CHUNK_STATE.UPLOADED, CHUNK_STATE.VERIFIED] } })
    .toArray();
  const uploadedBytes = chunks.reduce((sum, chunk) => sum + Number(chunk.byteLength || 0), 0);
  const completedChunks = chunks.length;
  const state = session.state === UPLOAD_STATE.FINALIZED
    ? UPLOAD_STATE.FINALIZED
    : completedChunks === session.totalChunks
      ? UPLOAD_STATE.IN_PROGRESS
      : session.state === UPLOAD_STATE.INITIALIZED
        ? UPLOAD_STATE.IN_PROGRESS
        : session.state;

  await db.collection(UPLOAD_SESSIONS_COLLECTION).updateOne(
    { _id: session._id },
    { $set: { completedChunks, uploadedBytes, state, updatedAt: now } }
  );
  return { completedChunks, uploadedBytes, state };
}

export async function recordUploadChunk({
  db,
  sessionId,
  uploadToken,
  uploader,
  chunkIndex,
  chunkBytes,
  expectedChunkHash,
  now = new Date(),
} = {}) {
  requireDb(db);
  const session = await authorizeSession({ db, sessionId, uploadToken, uploader });
  assertMutable(session);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
    throw new ResumableUploadError('INVALID_CHUNK_INDEX', 'Chunk index is outside the session range');
  }

  const bytes = Buffer.isBuffer(chunkBytes) ? chunkBytes : Buffer.from(chunkBytes || '');
  const expectedByteLength = Math.min(
    session.chunkSize,
    session.totalBytes - chunkIndex * session.chunkSize
  );
  if (bytes.length !== expectedByteLength) {
    throw new ResumableUploadError('INVALID_CHUNK_SIZE', `Chunk ${chunkIndex} must contain ${expectedByteLength} bytes`);
  }

  const actualHash = hashBytes(bytes);
  const normalizedExpected = String(expectedChunkHash || '').toLowerCase();
  if (!/^[a-fA-F0-9]{64}$/.test(normalizedExpected) || normalizedExpected !== actualHash) {
    await db.collection(UPLOAD_CHUNKS_COLLECTION).updateOne(
      { _id: `${sessionId}:chunk:${chunkIndex}` },
      {
        $set: {
          sessionId,
          chunkIndex,
          state: CHUNK_STATE.FAILED,
          lastError: 'chunk_hash_mismatch',
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
    throw new ResumableUploadError('CHUNK_HASH_MISMATCH', `Chunk ${chunkIndex} failed integrity validation`);
  }

  const existing = await db.collection(UPLOAD_CHUNKS_COLLECTION)
    .findOne({ _id: `${sessionId}:chunk:${chunkIndex}` });
  if (existing?.state === CHUNK_STATE.VERIFIED && existing.chunkHash === actualHash) {
    const progress = await recomputeProgress(db, session, now);
    return { ...progress, chunkIndex, chunkHash: actualHash, replayed: true };
  }

  await db.collection(UPLOAD_CHUNKS_COLLECTION).updateOne(
    { _id: `${sessionId}:chunk:${chunkIndex}` },
    {
      $set: {
        sessionId,
        chunkIndex,
        chunkHash: actualHash,
        byteLength: bytes.length,
        data: bytes.toString('base64'),
        state: CHUNK_STATE.VERIFIED,
        lastError: null,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );

  const progress = await recomputeProgress(db, session, now);
  return { ...progress, chunkIndex, chunkHash: actualHash, replayed: false };
}

export async function getUploadProgress({ db, sessionId, uploadToken, uploader } = {}) {
  requireDb(db);
  const session = await authorizeSession({ db, sessionId, uploadToken, uploader });
  const chunks = await db.collection(UPLOAD_CHUNKS_COLLECTION)
    .find({ sessionId })
    .sort({ chunkIndex: 1 })
    .toArray();
  const verified = new Set(
    chunks.filter((chunk) => chunk.state === CHUNK_STATE.VERIFIED).map((chunk) => chunk.chunkIndex)
  );
  const missingChunks = Array.from({ length: session.totalChunks }, (_, i) => i)
    .filter((index) => !verified.has(index));

  return {
    sessionId,
    state: session.state,
    totalChunks: session.totalChunks,
    completedChunks: verified.size,
    totalBytes: session.totalBytes,
    uploadedBytes: chunks
      .filter((chunk) => chunk.state === CHUNK_STATE.VERIFIED)
      .reduce((sum, chunk) => sum + Number(chunk.byteLength || 0), 0),
    percentage: Math.round((verified.size / session.totalChunks) * 100),
    missingChunks,
    expiresAt: session.expiresAt,
  };
}

export async function pauseUploadSession({ db, sessionId, uploadToken, uploader, now = new Date() } = {}) {
  requireDb(db);
  const session = await authorizeSession({ db, sessionId, uploadToken, uploader });
  assertMutable(session);
  await db.collection(UPLOAD_SESSIONS_COLLECTION).updateOne(
    { _id: sessionId },
    { $set: { state: UPLOAD_STATE.PAUSED, updatedAt: now } }
  );
  return getUploadProgress({ db, sessionId, uploadToken, uploader });
}

export async function resumeUploadSession({ db, sessionId, uploadToken, uploader, now = new Date() } = {}) {
  requireDb(db);
  const session = await authorizeSession({ db, sessionId, uploadToken, uploader });
  if (session.state !== UPLOAD_STATE.PAUSED && session.state !== UPLOAD_STATE.FAILED) {
    throw new ResumableUploadError('INVALID_SESSION_STATE', `Cannot resume session in state ${session.state}`);
  }
  await db.collection(UPLOAD_SESSIONS_COLLECTION).updateOne(
    { _id: sessionId },
    { $set: { state: UPLOAD_STATE.IN_PROGRESS, updatedAt: now } }
  );
  return getUploadProgress({ db, sessionId, uploadToken, uploader });
}

export async function finalizeUploadSession({
  db,
  sessionId,
  uploadToken,
  uploader,
  pinFn,
  createQuarantineFn,
  enqueueScanFn,
  now = new Date(),
} = {}) {
  requireDb(db);
  if (typeof pinFn !== 'function' || typeof createQuarantineFn !== 'function' || typeof enqueueScanFn !== 'function') {
    throw new ResumableUploadError('MISSING_DEPENDENCY', 'Storage and quarantine adapters are required');
  }
  const session = await authorizeSession({ db, sessionId, uploadToken, uploader });

  if (session.state === UPLOAD_STATE.FINALIZED && session.result) {
    return { ...session.result, replayed: true };
  }

  const fail = async (code, message) => {
    await db.collection(UPLOAD_SESSIONS_COLLECTION).updateOne(
      { _id: sessionId },
      { $set: { state: UPLOAD_STATE.FAILED, lastError: code, updatedAt: now } }
    );
    throw new ResumableUploadError(code, message);
  };

  const chunks = await db.collection(UPLOAD_CHUNKS_COLLECTION)
    .find({ sessionId, state: CHUNK_STATE.VERIFIED })
    .sort({ chunkIndex: 1 })
    .toArray();
  if (chunks.length !== session.totalChunks) {
    return fail('INCOMPLETE_UPLOAD', `Expected ${session.totalChunks} chunks but found ${chunks.length}`);
  }
  for (let i = 0; i < session.totalChunks; i += 1) {
    if (Number(chunks[i].chunkIndex) !== i) {
      return fail('MISSING_CHUNK', `Chunk ${i} is missing`);
    }
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, 'base64')));
  if (bytes.length !== session.totalBytes) {
    return fail('LENGTH_MISMATCH', 'Assembled upload length does not match the session');
  }
  const byteHash = hashBytes(bytes);
  if (byteHash !== session.expectedHash) {
    return fail('BYTE_HASH_MISMATCH', 'Assembled bytes do not match the declared SHA-256');
  }

  try {
    const pinned = await pinFn({ bytes, fileName: session.fileName, mimeType: session.mimeType });
    const quarantine = await createQuarantineFn({
      contentHash: pinned.cid,
      byteHash,
      fileName: session.fileName,
      mimeType: session.mimeType,
      sizeBytes: bytes.length,
      uploaderAddress: session.uploader,
    });
    await enqueueScanFn({ quarantine });

    const result = {
      sessionId,
      cid: pinned.cid,
      fileUrl: pinned.url || null,
      byteHash,
      totalChunks: session.totalChunks,
      totalBytes: session.totalBytes,
      quarantineState: quarantine?.state || 'pending',
    };
    await db.collection(UPLOAD_SESSIONS_COLLECTION).updateOne(
      { _id: sessionId },
      { $set: { state: UPLOAD_STATE.FINALIZED, result, lastError: null, updatedAt: now } }
    );
    return { ...result, replayed: false };
  } catch (error) {
    await db.collection(UPLOAD_SESSIONS_COLLECTION).updateOne(
      { _id: sessionId },
      { $set: { state: UPLOAD_STATE.FAILED, lastError: error.message || String(error), updatedAt: now } }
    );
    throw error;
  }
}

export async function cleanupExpiredUploads({ db, now = new Date() } = {}) {
  requireDb(db);
  const expiredStates = [
    UPLOAD_STATE.INITIALIZED,
    UPLOAD_STATE.PAUSED,
    UPLOAD_STATE.FAILED,
  ];
  const expired = await db.collection(UPLOAD_SESSIONS_COLLECTION)
    .find({ expiresAt: { $lt: now }, state: { $in: expiredStates } })
    .toArray();
  const ids = expired.map((session) => session._id);
  if (ids.length === 0) return { deletedSessions: 0, deletedChunks: 0 };

  const sessions = await db.collection(UPLOAD_SESSIONS_COLLECTION).deleteMany({ _id: { $in: ids } });
  const chunks = await db.collection(UPLOAD_CHUNKS_COLLECTION).deleteMany({ sessionId: { $in: ids } });
  return { deletedSessions: sessions.deletedCount, deletedChunks: chunks.deletedCount };
}

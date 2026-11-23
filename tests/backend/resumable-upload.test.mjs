import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeCollection, createFakeDb } from '../../src/lib/refunds/__tests__/fakeMongo.js';
import {
  createUploadSession,
  finalizeUploadSession,
  getUploadProgress,
  hashBytes,
  pauseUploadSession,
  recordUploadChunk,
  ResumableUploadError,
  resumeUploadSession,
  UPLOAD_CHUNKS_COLLECTION,
  UPLOAD_SESSIONS_COLLECTION,
} from '../../src/lib/storage/resumableUpload.js';

function makeContext({ size = 2500, chunkSize = 1024 } = {}) {
  const bytes = Buffer.alloc(size, 0x61);
  for (let i = 0; i < size; i += 257) bytes[i] = i % 251;
  const collections = {
    [UPLOAD_SESSIONS_COLLECTION]: createFakeCollection(),
    [UPLOAD_CHUNKS_COLLECTION]: createFakeCollection(),
    quarantine: createFakeCollection(),
  };
  return {
    db: createFakeDb(collections),
    collections,
    bytes,
    expectedHash: hashBytes(bytes),
    uploader: { walletAddress: 'GCREATOR1174' },
    metadata: {
      fileName: 'large-material.pdf',
      size,
      chunkSize,
      mimeType: 'application/pdf',
      expectedHash: hashBytes(bytes),
    },
  };
}

function chunksOf(bytes, chunkSize) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return chunks;
}

function adapters(overrides = {}) {
  const calls = { pin: [], quarantine: [], scan: [] };
  return {
    calls,
    pinFn: async (input) => {
      calls.pin.push(input);
      return { cid: 'QmResumable1174', url: 'https://gateway.test/ipfs/QmResumable1174' };
    },
    createQuarantineFn: async (input) => {
      calls.quarantine.push(input);
      return { contentHash: input.contentHash, state: 'pending' };
    },
    enqueueScanFn: async (input) => {
      calls.scan.push(input);
    },
    ...overrides,
  };
}

describe('resumable large-file upload (#1174)', () => {
  it('rejects anonymous session creation', async () => {
    const { db, metadata } = makeContext();
    await assert.rejects(
      createUploadSession({ db, uploader: null, metadata }),
      (error) => error instanceof ResumableUploadError && error.code === 'UNAUTHORIZED_UPLOAD'
    );
  });

  it('requires an exact SHA-256 declaration before creating a session', async () => {
    const { db, uploader, metadata } = makeContext();
    await assert.rejects(
      createUploadSession({ db, uploader, metadata: { ...metadata, expectedHash: 'bad' } }),
      (error) => error instanceof ResumableUploadError && error.code === 'INVALID_EXPECTED_HASH'
    );
  });

  it('records verified chunks, resumes from progress, and finalizes exact bytes once', async () => {
    const ctx = makeContext();
    const session = await createUploadSession({ db: ctx.db, uploader: ctx.uploader, metadata: ctx.metadata });
    const chunks = chunksOf(ctx.bytes, ctx.metadata.chunkSize);

    await recordUploadChunk({
      db: ctx.db,
      sessionId: session._id,
      uploadToken: session.uploadToken,
      uploader: ctx.uploader,
      chunkIndex: 0,
      chunkBytes: chunks[0],
      expectedChunkHash: hashBytes(chunks[0]),
    });
    const paused = await pauseUploadSession({
      db: ctx.db,
      sessionId: session._id,
      uploadToken: session.uploadToken,
      uploader: ctx.uploader,
    });
    assert.equal(paused.state, 'paused');
    assert.deepEqual(paused.missingChunks, [1, 2]);

    const resumed = await resumeUploadSession({
      db: ctx.db,
      sessionId: session._id,
      uploadToken: session.uploadToken,
      uploader: ctx.uploader,
    });
    assert.equal(resumed.completedChunks, 1);

    for (let i = 1; i < chunks.length; i += 1) {
      await recordUploadChunk({
        db: ctx.db,
        sessionId: session._id,
        uploadToken: session.uploadToken,
        uploader: ctx.uploader,
        chunkIndex: i,
        chunkBytes: chunks[i],
        expectedChunkHash: hashBytes(chunks[i]),
      });
    }

    const progress = await getUploadProgress({
      db: ctx.db,
      sessionId: session._id,
      uploadToken: session.uploadToken,
      uploader: ctx.uploader,
    });
    assert.equal(progress.percentage, 100);
    assert.deepEqual(progress.missingChunks, []);

    const deps = adapters();
    const result = await finalizeUploadSession({
      db: ctx.db,
      sessionId: session._id,
      uploadToken: session.uploadToken,
      uploader: ctx.uploader,
      ...deps,
    });
    assert.equal(result.byteHash, ctx.expectedHash);
    assert.equal(result.replayed, false);
    assert.equal(deps.calls.pin.length, 1);
    assert.equal(deps.calls.quarantine[0].byteHash, ctx.expectedHash);
    assert.equal(deps.calls.scan.length, 1);

    const replay = await finalizeUploadSession({
      db: ctx.db,
      sessionId: session._id,
      uploadToken: session.uploadToken,
      uploader: ctx.uploader,
      ...deps,
    });
    assert.equal(replay.replayed, true);
    assert.equal(deps.calls.pin.length, 1);
  });

  it('keeps verified chunks when finalization is attempted early, then completes', async () => {
    const ctx = makeContext();
    const session = await createUploadSession({ db: ctx.db, uploader: ctx.uploader, metadata: ctx.metadata });
    const chunks = chunksOf(ctx.bytes, ctx.metadata.chunkSize);
    await recordUploadChunk({
      db: ctx.db,
      sessionId: session._id,
      uploadToken: session.uploadToken,
      uploader: ctx.uploader,
      chunkIndex: 0,
      chunkBytes: chunks[0],
      expectedChunkHash: hashBytes(chunks[0]),
    });

    await assert.rejects(
      finalizeUploadSession({
        db: ctx.db,
        sessionId: session._id,
        uploadToken: session.uploadToken,
        uploader: ctx.uploader,
        ...adapters(),
      }),
      (error) => error.code === 'INCOMPLETE_UPLOAD'
    );
    assert.equal(ctx.collections[UPLOAD_CHUNKS_COLLECTION].docs.length, 1);

    for (let i = 1; i < chunks.length; i += 1) {
      await recordUploadChunk({
        db: ctx.db,
        sessionId: session._id,
        uploadToken: session.uploadToken,
        uploader: ctx.uploader,
        chunkIndex: i,
        chunkBytes: chunks[i],
        expectedChunkHash: hashBytes(chunks[i]),
      });
    }
    const result = await finalizeUploadSession({
      db: ctx.db,
      sessionId: session._id,
      uploadToken: session.uploadToken,
      uploader: ctx.uploader,
      ...adapters(),
    });
    assert.equal(result.byteHash, ctx.expectedHash);
  });

  it('rejects a corrupted chunk and records the failure without accepting it', async () => {
    const ctx = makeContext();
    const session = await createUploadSession({ db: ctx.db, uploader: ctx.uploader, metadata: ctx.metadata });
    await assert.rejects(
      recordUploadChunk({
        db: ctx.db,
        sessionId: session._id,
        uploadToken: session.uploadToken,
        uploader: ctx.uploader,
        chunkIndex: 0,
        chunkBytes: Buffer.alloc(ctx.metadata.chunkSize, 0x7a),
        expectedChunkHash: hashBytes(Buffer.alloc(ctx.metadata.chunkSize, 0x61)),
      }),
      (error) => error.code === 'CHUNK_HASH_MISMATCH'
    );
    const progress = await getUploadProgress({
      db: ctx.db,
      sessionId: session._id,
      uploadToken: session.uploadToken,
      uploader: ctx.uploader,
    });
    assert.equal(progress.completedChunks, 0);
    assert.equal(ctx.collections[UPLOAD_CHUNKS_COLLECTION].docs[0].state, 'failed');
  });

  it('rejects an uploader who does not own the session token', async () => {
    const ctx = makeContext();
    const session = await createUploadSession({ db: ctx.db, uploader: ctx.uploader, metadata: ctx.metadata });
    await assert.rejects(
      getUploadProgress({
        db: ctx.db,
        sessionId: session._id,
        uploadToken: session.uploadToken,
        uploader: { walletAddress: 'GOTHER1174' },
      }),
      (error) => error.code === 'UNAUTHORIZED_UPLOAD'
    );
  });
});

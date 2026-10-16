import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBackfill, loadCheckpoint, formatDiffReport } from './backfill-runner.mjs';

/** Minimal in-memory stand-in for the slice of the Mongo collection API this module uses. */
function fakeCollection(initialDocs) {
  const docs = initialDocs.map((d) => ({ ...d }));
  return {
    docs,
    find(filter) {
      const matches = docs
        .filter((d) => matchesFilter(d, filter))
        .sort((a, b) => (a._id > b._id ? 1 : a._id < b._id ? -1 : 0));
      let limit = Infinity;
      const api = {
        sort() {
          return api;
        },
        limit(n) {
          limit = n;
          return api;
        },
        [Symbol.asyncIterator]() {
          const slice = matches.slice(0, limit);
          let i = 0;
          return {
            next() {
              if (i >= slice.length) return Promise.resolve({ done: true });
              return Promise.resolve({ done: false, value: slice[i++] });
            },
          };
        },
      };
      return api;
    },
    async updateOne(filter, update) {
      const doc = docs.find((d) => matchesFilter(d, filter));
      if (!doc) return { matchedCount: 0 };
      Object.assign(doc, update.$set);
      return { matchedCount: 1 };
    },
  };
}

function matchesFilter(doc, filter) {
  if (filter.$and) return filter.$and.every((f) => matchesFilter(doc, f));
  return Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$exists' in cond) return cond.$exists ? value !== undefined : value === undefined;
      if ('$gt' in cond) return value > cond.$gt;
    }
    return value === cond;
  });
}

describe('runBackfill', () => {
  let checkpointDir;
  let checkpointPath;

  beforeEach(() => {
    checkpointDir = mkdtempSync(path.join(tmpdir(), 'backfill-test-'));
    checkpointPath = path.join(checkpointDir, 'checkpoint.json');
  });

  afterEach(() => {
    rmSync(checkpointDir, { recursive: true, force: true });
  });

  it('dry-run reports the diff without writing anything', async () => {
    const collection = fakeCollection([
      { _id: 'a', previewImages: undefined },
      { _id: 'b', previewImages: undefined },
    ]);

    const result = await runBackfill({
      collection,
      query: { previewImages: { $exists: false } },
      computeUpdate: () => ({ previewImages: [] }),
      checkpointPath,
      execute: false,
      log: () => {},
    });

    expect(result.updated).toBe(2);
    expect(collection.docs.every((d) => d.previewImages === undefined)).toBe(true);
  });

  it('execute mode writes the computed patch', async () => {
    const collection = fakeCollection([{ _id: 'a', previewImages: undefined }]);

    const result = await runBackfill({
      collection,
      query: { previewImages: { $exists: false } },
      computeUpdate: () => ({ previewImages: [] }),
      checkpointPath,
      execute: true,
      log: () => {},
    });

    expect(result.updated).toBe(1);
    expect(collection.docs[0].previewImages).toEqual([]);
  });

  it('skips records where computeUpdate returns no patch', async () => {
    const collection = fakeCollection([
      { _id: 'a', previewImages: undefined },
      { _id: 'b', previewImages: [] },
    ]);

    const result = await runBackfill({
      collection,
      query: {},
      computeUpdate: (doc) => (doc.previewImages === undefined ? { previewImages: [] } : null),
      checkpointPath,
      execute: true,
      log: () => {},
    });

    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('counts a failing computeUpdate as failed without aborting the run', async () => {
    const collection = fakeCollection([
      { _id: 'a', previewImages: undefined },
      { _id: 'b', previewImages: undefined },
    ]);

    const result = await runBackfill({
      collection,
      query: {},
      computeUpdate: (doc) => {
        if (doc._id === 'a') throw new Error('boom');
        return { previewImages: [] };
      },
      checkpointPath,
      execute: true,
      log: () => {},
    });

    expect(result.failed).toBe(1);
    expect(result.updated).toBe(1);
  });

  it('persists a checkpoint and resumes after the last processed _id', async () => {
    const collection = fakeCollection([
      { _id: 'a', previewImages: undefined },
      { _id: 'b', previewImages: undefined },
      { _id: 'c', previewImages: undefined },
    ]);

    await runBackfill({
      collection,
      query: { previewImages: { $exists: false } },
      computeUpdate: () => ({ previewImages: [] }),
      checkpointPath,
      execute: true,
      batchSize: 1,
      log: () => {},
    });

    expect(existsSync(checkpointPath)).toBe(true);
    const saved = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    expect(saved.lastId).toBe('c');
    expect(saved.processed).toBe(3);

    // Simulate a second invocation against a collection where everything
    // was already written -- resuming must not reprocess "a" and "b".
    const resumed = await runBackfill({
      collection,
      query: { previewImages: { $exists: false } },
      computeUpdate: () => ({ previewImages: [] }),
      checkpointPath,
      execute: true,
      log: () => {},
    });

    expect(resumed.processed).toBe(3); // carried forward from the checkpoint, nothing new to scan
  });

  it('loadCheckpoint falls back to a fresh checkpoint on a corrupt file', () => {
    mkdirSync(path.dirname(checkpointPath), { recursive: true });
    writeFileSync(checkpointPath, '{not valid json');

    const checkpoint = loadCheckpoint(checkpointPath);
    expect(checkpoint.lastId).toBeNull();
    expect(checkpoint.processed).toBe(0);
  });
});

describe('formatDiffReport', () => {
  it('truncates long diff lists and reports the remainder count', () => {
    const diffs = Array.from({ length: 5 }, (_, i) => ({ id: `id-${i}`, patch: { x: i } }));
    const report = formatDiffReport(diffs, { maxLines: 2 });
    expect(report).toContain('5 record(s) would change');
    expect(report).toContain('... and 3 more');
  });
});

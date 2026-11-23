import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  CancellationError,
  OperationStatus,
  OperationType,
  createOperation,
  getOperation,
  updateOperation,
  cancelOperation,
  checkCancellation,
  startOperation,
  updateProgress,
  completeOperation,
  failOperation,
  listOperations,
  cleanupOldOperations,
  pauseOperation,
  resumeOperation,
  getOperationStats,
} from '../cancellation.js';

describe('Safe Cancellation System (Issue #997)', () => {
  let mockDb;

  beforeEach(() => {
    const operations = [];

    mockDb = {
      collection: (name) => ({
        insertOne: async (doc) => {
          const id = `${Date.now()}_${operations.length}`;
          operations.push({ ...doc, _id: id });
          return { insertedId: id };
        },
        findOne: async (query) => {
          return operations.find((op) =>
            Object.entries(query).every(([key, value]) => op[key] === value)
          );
        },
        find: (query) => ({
          sort: (order) => ({
            limit: (n) => ({
              toArray: async () => {
                return operations
                  .filter((op) =>
                    Object.entries(query).every(([key, value]) => op[key] === value)
                  )
                  .sort((a, b) => {
                    const [field, dir] = Object.entries(order)[0];
                    const cmp = a[field] < b[field] ? -1 : 1;
                    return dir === -1 ? -cmp : cmp;
                  })
                  .slice(0, n);
              },
            }),
          }),
        }),
        findOneAndUpdate: async (query, update, options) => {
          const index = operations.findIndex((op) =>
            Object.entries(query).every(([key, value]) => op[key] === value)
          );
          if (index === -1) return { value: null };

          const updated = {
            ...operations[index],
            ...update.$set,
          };
          operations[index] = updated;
          return { value: options?.returnDocument === 'after' ? updated : null };
        },
        deleteMany: async (query) => {
          const before = operations.length;
          const filtered = operations.filter((op) =>
            Object.entries(query).every(([key, value]) => {
              if (typeof value === 'object' && value.$lt) {
                return op[key] < value.$lt;
              }
              if (typeof value === 'object' && value.$in) {
                return value.$in.includes(op[key]);
              }
              return op[key] === value;
            })
          );
          operations.length = 0;
          operations.push(
            ...operations.filter((op) => !filtered.includes(op))
          );
          return { deletedCount: filtered.length };
        },
        aggregate: (pipeline) => ({
          toArray: async () => {
            const byStatus = {};
            operations.forEach((op) => {
              byStatus[op.status] = (byStatus[op.status] || 0) + 1;
            });
            return Object.entries(byStatus).map(([status, count]) => ({
              _id: status,
              count,
            }));
          },
        }),
      }),
    };
  });

  describe('Operation Lifecycle', () => {
    it('should create an operation with pending status', async () => {
      const op = await createOperation(mockDb, {
        type: 'export',
        userId: 'user123',
        sourceId: 'material456',
        sourceType: 'material',
      });

      assert(op.operationId);
      assert.strictEqual(op.status, OperationStatus.PENDING);
      assert.strictEqual(op.type, 'export');
      assert.strictEqual(op.userId, 'user123');
    });

    it('should transition from pending to running', async () => {
      const op = await createOperation(mockDb, {
        type: 'import',
        userId: 'user123',
        sourceId: 'file123',
        sourceType: 'file',
      });

      const started = await startOperation(mockDb, op.operationId);
      assert.strictEqual(started.status, OperationStatus.RUNNING);
      assert(started.startedAt);
    });

    it('should complete an operation', async () => {
      const op = await createOperation(mockDb, {
        type: 'export',
        userId: 'user123',
        sourceId: 'lib123',
        sourceType: 'library',
      });

      await startOperation(mockDb, op.operationId);
      const completed = await completeOperation(mockDb, op.operationId, {
        itemsProcessed: 42,
        fileUrl: 'https://example.com/export.zip',
      });

      assert.strictEqual(completed.status, OperationStatus.COMPLETED);
      assert(completed.completedAt);
      assert(completed.result);
    });

    it('should mark operation as failed', async () => {
      const op = await createOperation(mockDb, {
        type: 'import',
        userId: 'user123',
        sourceId: 'file123',
        sourceType: 'file',
      });

      const failed = await failOperation(mockDb, op.operationId, new Error('Upload failed'));
      assert.strictEqual(failed.status, OperationStatus.FAILED);
      assert(failed.failedAt);
      assert(failed.error);
    });
  });

  describe('Cancellation', () => {
    it('should cancel a running operation', async () => {
      const op = await createOperation(mockDb, {
        type: 'export',
        userId: 'user123',
        sourceId: 'lib123',
        sourceType: 'library',
      });

      await startOperation(mockDb, op.operationId);
      const cancelled = await cancelOperation(mockDb, op.operationId, 'User requested');

      assert.strictEqual(cancelled.status, OperationStatus.CANCELLED);
      assert(cancelled.cancelledAt);
      assert.match(cancelled.error, /requested/i);
    });

    it('should be idempotent for already cancelled operations', async () => {
      const op = await createOperation(mockDb, {
        type: 'export',
        userId: 'user123',
        sourceId: 'lib123',
        sourceType: 'library',
      });

      await cancelOperation(mockDb, op.operationId);
      const secondCancel = await cancelOperation(mockDb, op.operationId);

      assert.strictEqual(secondCancel.status, OperationStatus.CANCELLED);
    });

    it('should not cancel completed operations', async () => {
      const op = await createOperation(mockDb, {
        type: 'export',
        userId: 'user123',
        sourceId: 'lib123',
        sourceType: 'library',
      });

      await startOperation(mockDb, op.operationId);
      await completeOperation(mockDb, op.operationId);

      const result = await cancelOperation(mockDb, op.operationId);
      assert.strictEqual(result.status, OperationStatus.COMPLETED);
    });

    it('should check cancellation status', async () => {
      const op = await createOperation(mockDb, {
        type: 'export',
        userId: 'user123',
        sourceId: 'lib123',
        sourceType: 'library',
      });

      let shouldCancel = await checkCancellation(mockDb, op.operationId);
      assert.strictEqual(shouldCancel, false);

      await cancelOperation(mockDb, op.operationId);
      shouldCancel = await checkCancellation(mockDb, op.operationId);
      assert.strictEqual(shouldCancel, true);
    });
  });

  describe('Progress Tracking', () => {
    it('should update operation progress', async () => {
      const op = await createOperation(mockDb, {
        type: 'import',
        userId: 'user123',
        sourceId: 'file123',
        sourceType: 'file',
        metadata: { totalItems: 100 },
      });

      await startOperation(mockDb, op.operationId);
      const updated = await updateProgress(mockDb, op.operationId, 25, 100);

      assert.strictEqual(updated.progress.processed, 25);
      assert.strictEqual(updated.progress.total, 100);
      assert.strictEqual(updated.progress.percentage, 25);
    });

    it('should calculate progress percentage correctly', async () => {
      const op = await createOperation(mockDb, {
        type: 'export',
        userId: 'user123',
        sourceId: 'lib123',
        sourceType: 'library',
      });

      const testCases = [
        { processed: 0, total: 100, expected: 0 },
        { processed: 50, total: 100, expected: 50 },
        { processed: 100, total: 100, expected: 100 },
        { processed: 33, total: 100, expected: 33 },
      ];

      for (const { processed, total, expected } of testCases) {
        const updated = await updateProgress(mockDb, op.operationId, processed, total);
        assert.strictEqual(updated.progress.percentage, expected);
      }
    });
  });

  describe('Pause & Resume', () => {
    it('should pause a running operation', async () => {
      const op = await createOperation(mockDb, {
        type: 'import',
        userId: 'user123',
        sourceId: 'file123',
        sourceType: 'file',
      });

      await startOperation(mockDb, op.operationId);
      const paused = await pauseOperation(mockDb, op.operationId, 'Rate limit reached');

      assert.strictEqual(paused.status, OperationStatus.PAUSED);
      assert.match(paused.error, /rate limit/i);
    });

    it('should resume a paused operation', async () => {
      const op = await createOperation(mockDb, {
        type: 'import',
        userId: 'user123',
        sourceId: 'file123',
        sourceType: 'file',
      });

      await startOperation(mockDb, op.operationId);
      await pauseOperation(mockDb, op.operationId);
      const resumed = await resumeOperation(mockDb, op.operationId);

      assert.strictEqual(resumed.status, OperationStatus.RUNNING);
    });

    it('should not allow pausing non-running operations', async () => {
      const op = await createOperation(mockDb, {
        type: 'export',
        userId: 'user123',
        sourceId: 'lib123',
        sourceType: 'library',
      });

      try {
        await pauseOperation(mockDb, op.operationId);
        assert.fail('Should have thrown CancellationError');
      } catch (err) {
        assert(err instanceof CancellationError);
      }
    });
  });

  describe('Operation Listing', () => {
    it('should list operations for a user', async () => {
      await createOperation(mockDb, {
        type: 'export',
        userId: 'user123',
        sourceId: 'lib1',
        sourceType: 'library',
      });

      await createOperation(mockDb, {
        type: 'import',
        userId: 'user123',
        sourceId: 'file1',
        sourceType: 'file',
      });

      const ops = await listOperations(mockDb, 'user123');
      assert.strictEqual(ops.length, 2);
    });

    it('should filter operations by type', async () => {
      await createOperation(mockDb, {
        type: 'export',
        userId: 'user123',
        sourceId: 'lib1',
        sourceType: 'library',
      });

      await createOperation(mockDb, {
        type: 'import',
        userId: 'user123',
        sourceId: 'file1',
        sourceType: 'file',
      });

      const exports = await listOperations(mockDb, 'user123', { type: 'export' });
      assert.strictEqual(exports.length, 1);
      assert.strictEqual(exports[0].type, 'export');
    });

    it('should filter operations by status', async () => {
      const op1 = await createOperation(mockDb, {
        type: 'export',
        userId: 'user123',
        sourceId: 'lib1',
        sourceType: 'library',
      });

      const op2 = await createOperation(mockDb, {
        type: 'import',
        userId: 'user123',
        sourceId: 'file1',
        sourceType: 'file',
      });

      await completeOperation(mockDb, op1.operationId);

      const completed = await listOperations(mockDb, 'user123', { status: 'completed' });
      assert(completed.length > 0);
    });
  });

  describe('Validation', () => {
    it('should reject invalid operation types', async () => {
      try {
        await createOperation(mockDb, {
          type: 'invalid_type',
          userId: 'user123',
          sourceId: 'id123',
          sourceType: 'type',
        });
        assert.fail('Should have thrown CancellationError');
      } catch (err) {
        assert(err instanceof CancellationError);
      }
    });

    it('should reject cancellation of non-existent operation', async () => {
      try {
        await cancelOperation(mockDb, 'nonexistent_id');
        assert.fail('Should have thrown CancellationError');
      } catch (err) {
        assert(err instanceof CancellationError);
        assert.match(err.message, /not found/i);
      }
    });
  });
});

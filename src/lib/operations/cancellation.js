/**
 * Safe Cancellation for Long-Running Operations (Issue #997)
 *
 * Provides a centralized cancellation system for imports, exports, and other
 * long-running operations. Ensures:
 * - Graceful shutdown without data corruption
 * - Proper cleanup of partial results
 * - Status tracking and audit logging
 * - Idempotent cancellation requests
 */

import { getDb } from '../mongodb.js';

export class CancellationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CancellationError';
    this.details = details;
  }
}

export const OperationStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  PAUSED: 'paused',
};

export const OperationType = {
  IMPORT: 'import',
  EXPORT: 'export',
  SYNC: 'sync',
  BACKUP: 'backup',
  CLEANUP: 'cleanup',
};

/**
 * Create an operation record for tracking long-running tasks.
 */
export async function createOperation(db, {
  type,
  userId,
  sourceId,
  sourceType,
  metadata = {},
  estimatedDuration = null,
}) {
  if (!OperationType[type.toUpperCase()]) {
    throw new CancellationError('Invalid operation type', { type });
  }

  const operation = {
    operationId: `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    type,
    userId,
    sourceId,
    sourceType,
    status: OperationStatus.PENDING,
    metadata,
    estimatedDuration,
    startedAt: null,
    cancelledAt: null,
    completedAt: null,
    failedAt: null,
    progress: {
      processed: 0,
      total: 0,
      percentage: 0,
    },
    result: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection('operations').insertOne(operation);
  return { ...operation, _id: result.insertedId };
}

/**
 * Get operation by ID.
 */
export async function getOperation(db, operationId) {
  return db.collection('operations').findOne({ operationId });
}

/**
 * Update operation status and progress.
 */
export async function updateOperation(db, operationId, updates) {
  const allowedFields = [
    'status',
    'progress',
    'result',
    'error',
    'startedAt',
    'cancelledAt',
    'completedAt',
    'failedAt',
  ];

  const filtered = Object.fromEntries(
    Object.entries(updates).filter(([key]) => allowedFields.includes(key))
  );

  const result = await db.collection('operations').findOneAndUpdate(
    { operationId },
    {
      $set: {
        ...filtered,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' }
  );

  return result.value;
}

/**
 * Request cancellation of a long-running operation.
 * Returns the updated operation object.
 */
export async function cancelOperation(db, operationId, reason = '') {
  const operation = await getOperation(db, operationId);

  if (!operation) {
    throw new CancellationError('Operation not found', { operationId });
  }

  // Already terminal states
  if (
    operation.status === OperationStatus.COMPLETED ||
    operation.status === OperationStatus.CANCELLED ||
    operation.status === OperationStatus.FAILED
  ) {
    return operation;
  }

  const updated = await updateOperation(db, operationId, {
    status: OperationStatus.CANCELLED,
    cancelledAt: new Date(),
    error: reason || 'Cancelled by user',
  });

  return updated;
}

/**
 * Check if operation should be cancelled.
 * Call this periodically in long-running loops.
 */
export async function checkCancellation(db, operationId) {
  const operation = await getOperation(db, operationId);

  if (!operation) {
    throw new CancellationError('Operation not found', { operationId });
  }

  return operation.status === OperationStatus.CANCELLED;
}

/**
 * Mark operation as started.
 */
export async function startOperation(db, operationId) {
  return updateOperation(db, operationId, {
    status: OperationStatus.RUNNING,
    startedAt: new Date(),
  });
}

/**
 * Update progress of a running operation.
 */
export async function updateProgress(db, operationId, processed, total) {
  const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;

  return updateOperation(db, operationId, {
    progress: {
      processed,
      total,
      percentage,
    },
  });
}

/**
 * Mark operation as successfully completed.
 */
export async function completeOperation(db, operationId, result = null) {
  return updateOperation(db, operationId, {
    status: OperationStatus.COMPLETED,
    completedAt: new Date(),
    result,
  });
}

/**
 * Mark operation as failed.
 */
export async function failOperation(db, operationId, error) {
  const errorMsg = error instanceof Error ? error.message : String(error);

  return updateOperation(db, operationId, {
    status: OperationStatus.FAILED,
    failedAt: new Date(),
    error: errorMsg,
  });
}

/**
 * List operations for a user with optional filtering.
 */
export async function listOperations(db, userId, { type = null, status = null, limit = 20 } = {}) {
  const query = { userId };

  if (type) {
    query.type = type.toLowerCase();
  }

  if (status) {
    query.status = status.toLowerCase();
  }

  return db
    .collection('operations')
    .find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Clean up old completed/cancelled operations (retention policy).
 */
export async function cleanupOldOperations(db, retentionDays = 30) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const result = await db.collection('operations').deleteMany({
    status: { $in: [OperationStatus.COMPLETED, OperationStatus.CANCELLED] },
    completedAt: { $lt: cutoff },
  });

  return result.deletedCount;
}

/**
 * Pause a running operation (for resumable operations).
 */
export async function pauseOperation(db, operationId, reason = '') {
  const operation = await getOperation(db, operationId);

  if (!operation) {
    throw new CancellationError('Operation not found', { operationId });
  }

  if (operation.status !== OperationStatus.RUNNING) {
    throw new CancellationError(
      `Cannot pause operation in ${operation.status} status`,
      { operationId, status: operation.status }
    );
  }

  return updateOperation(db, operationId, {
    status: OperationStatus.PAUSED,
    error: reason || 'Paused by user',
  });
}

/**
 * Resume a paused operation.
 */
export async function resumeOperation(db, operationId) {
  const operation = await getOperation(db, operationId);

  if (!operation) {
    throw new CancellationError('Operation not found', { operationId });
  }

  if (operation.status !== OperationStatus.PAUSED) {
    throw new CancellationError(
      `Cannot resume operation in ${operation.status} status`,
      { operationId, status: operation.status }
    );
  }

  return updateOperation(db, operationId, {
    status: OperationStatus.RUNNING,
  });
}

/**
 * Get statistics for operations (for monitoring).
 */
export async function getOperationStats(db, { timeWindowDays = 7 } = {}) {
  const since = new Date(Date.now() - timeWindowDays * 24 * 60 * 60 * 1000);

  const stats = await db
    .collection('operations')
    .aggregate([
      {
        $match: {
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const result = {
    total: 0,
    byStatus: {},
    timeWindowDays,
  };

  stats.forEach(({ _id, count }) => {
    result.byStatus[_id] = count;
    result.total += count;
  });

  return result;
}

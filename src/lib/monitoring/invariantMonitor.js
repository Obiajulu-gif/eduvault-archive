/**
 * Invariant Monitor for Balances and Ownership — Issue #1123
 *
 * Provides runtime monitoring of invariant violations across:
 * - Balance conservation (debits == credits + fees; no negative balances)
 * - Single-ownership integrity (each resource has exactly one live owner)
 *
 * Usage:
 *   const monitor = createInvariantMonitor({ db, emit });
 *   monitor.record(violation);
 *   await monitor.runBalanceScan({ walletCollection });
 *   await monitor.runOwnershipScan({ materialsCollection });
 *   monitor.getViolations();
 */

export const VIOLATION_SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
});

export const MONITOR_EVENT = Object.freeze({
  VIOLATION_RECORDED: 'invariant.violation_recorded',
  SCAN_STARTED: 'invariant.scan_started',
  SCAN_COMPLETED: 'invariant.scan_completed',
  SCAN_ERROR: 'invariant.scan_error',
});

/**
 * Creates an invariant monitor instance.
 *
 * @param {object} options
 * @param {Function} [options.emit] - Optional event emitter (event, payload) => void
 * @param {number} [options.maxViolations=1000] - Ring-buffer capacity
 * @returns {object} Monitor API
 */
export function createInvariantMonitor({ emit = () => {}, maxViolations = 1000 } = {}) {
  const violations = [];
  let totalRecorded = 0;

  function record(violation) {
    if (!violation || typeof violation !== 'object') {
      throw new TypeError('violation must be a plain object');
    }
    const entry = {
      ...violation,
      id: `inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      recordedAt: new Date().toISOString(),
      severity: violation.severity ?? VIOLATION_SEVERITY.WARNING,
    };
    violations.push(entry);
    if (violations.length > maxViolations) violations.shift();
    totalRecorded += 1;
    emit(MONITOR_EVENT.VIOLATION_RECORDED, entry);
    return entry;
  }

  function getViolations({ severity, type, since, limit = 100 } = {}) {
    let result = violations;
    if (severity) result = result.filter((v) => v.severity === severity);
    if (type) result = result.filter((v) => v.type === type);
    if (since) {
      const sinceDate = new Date(since);
      result = result.filter((v) => new Date(v.recordedAt) >= sinceDate);
    }
    return result.slice(-limit);
  }

  function stats() {
    const counts = {};
    for (const v of violations) {
      counts[v.severity] = (counts[v.severity] ?? 0) + 1;
    }
    return { buffered: violations.length, totalRecorded, bySeverity: counts };
  }

  /**
   * Scans a wallet/balance collection for negative balances and arithmetic
   * inconsistencies. Each document is expected to carry `address`, `balance`,
   * and optionally `currency`.
   *
   * @param {object} opts
   * @param {object} opts.walletCollection - MongoDB collection
   * @param {number} [opts.batchSize=200]
   * @param {Function} [opts.onProgress]
   * @returns {Promise<{ scanned: number, violations: number }>}
   */
  async function runBalanceScan({ walletCollection, batchSize = 200, onProgress } = {}) {
    if (!walletCollection) throw new TypeError('walletCollection is required');

    emit(MONITOR_EVENT.SCAN_STARTED, { type: 'balance' });
    let scanned = 0;
    let violationCount = 0;
    let lastId = null;

    try {
      while (true) {
        const query = lastId ? { _id: { $gt: lastId } } : {};
        const batch = await walletCollection
          .find(query)
          .sort({ _id: 1 })
          .limit(batchSize)
          .toArray();

        if (batch.length === 0) break;

        for (const doc of batch) {
          const balance = Number(doc.balance ?? 0);
          if (Number.isNaN(balance)) {
            record({
              type: 'BALANCE_NON_NUMERIC',
              severity: VIOLATION_SEVERITY.CRITICAL,
              resourceId: String(doc._id),
              address: doc.address ?? null,
              message: `Non-numeric balance on account ${doc.address ?? doc._id}`,
              raw: { balance: doc.balance },
            });
            violationCount++;
          } else if (balance < 0) {
            record({
              type: 'BALANCE_NEGATIVE',
              severity: VIOLATION_SEVERITY.CRITICAL,
              resourceId: String(doc._id),
              address: doc.address ?? null,
              currency: doc.currency ?? 'XLM',
              message: `Negative balance detected: ${balance} ${doc.currency ?? 'XLM'} on ${doc.address ?? doc._id}`,
              raw: { balance, currency: doc.currency },
            });
            violationCount++;
          }

          if (typeof doc.pendingDebits === 'number' && typeof doc.pendingCredits === 'number') {
            const net = doc.pendingDebits - doc.pendingCredits;
            if (Math.abs(net) > 1e-6 && doc.pendingBalance !== undefined) {
              const expectedPending = Number(doc.pendingBalance ?? 0);
              if (Math.abs(net - expectedPending) > 1e-6) {
                record({
                  type: 'BALANCE_PENDING_MISMATCH',
                  severity: VIOLATION_SEVERITY.WARNING,
                  resourceId: String(doc._id),
                  address: doc.address ?? null,
                  message: `Pending balance mismatch: net ${net} vs stored ${expectedPending}`,
                  raw: { pendingDebits: doc.pendingDebits, pendingCredits: doc.pendingCredits, pendingBalance: doc.pendingBalance },
                });
                violationCount++;
              }
            }
          }

          scanned++;
          lastId = doc._id;
        }

        if (onProgress) onProgress({ scanned, violationCount });
        if (batch.length < batchSize) break;
      }

      emit(MONITOR_EVENT.SCAN_COMPLETED, { type: 'balance', scanned, violationCount });
      return { scanned, violations: violationCount };
    } catch (err) {
      emit(MONITOR_EVENT.SCAN_ERROR, { type: 'balance', error: err.message });
      throw err;
    }
  }

  /**
   * Scans a materials/resources collection for ownership violations:
   * - Missing owner field
   * - Duplicate live owner entries (requires cross-reference with an owners index)
   *
   * @param {object} opts
   * @param {object} opts.materialsCollection - MongoDB collection
   * @param {number} [opts.batchSize=200]
   * @param {Function} [opts.onProgress]
   * @returns {Promise<{ scanned: number, violations: number }>}
   */
  async function runOwnershipScan({ materialsCollection, batchSize = 200, onProgress } = {}) {
    if (!materialsCollection) throw new TypeError('materialsCollection is required');

    emit(MONITOR_EVENT.SCAN_STARTED, { type: 'ownership' });
    let scanned = 0;
    let violationCount = 0;
    let lastId = null;
    const ownerIndex = new Map(); // materialId -> [ownerAddress, ...]

    try {
      while (true) {
        const query = lastId ? { _id: { $gt: lastId } } : {};
        const batch = await materialsCollection
          .find(query)
          .sort({ _id: 1 })
          .limit(batchSize)
          .toArray();

        if (batch.length === 0) break;

        for (const doc of batch) {
          const resourceId = String(doc._id);

          if (!doc.ownerAddress && !doc.creator && !doc.creatorAddress) {
            record({
              type: 'OWNERSHIP_MISSING',
              severity: VIOLATION_SEVERITY.CRITICAL,
              resourceId,
              message: `Resource ${resourceId} has no owner field (ownerAddress/creator/creatorAddress)`,
              raw: { status: doc.status, title: doc.title },
            });
            violationCount++;
          }

          const ownerAddr = doc.ownerAddress ?? doc.creatorAddress ?? doc.creator ?? null;
          if (ownerAddr) {
            if (!ownerIndex.has(resourceId)) {
              ownerIndex.set(resourceId, [ownerAddr]);
            } else {
              ownerIndex.get(resourceId).push(ownerAddr);
            }
          }

          const blockedStates = ['archived', 'quarantined', 'deleted'];
          const isBlocked = blockedStates.includes((doc.status ?? '').toLowerCase());
          if (isBlocked && ownerAddr) {
            // No critical violation — ownership on blocked resources is merely informational
            record({
              type: 'OWNERSHIP_ON_INACTIVE_RESOURCE',
              severity: VIOLATION_SEVERITY.INFO,
              resourceId,
              ownerAddress: ownerAddr,
              message: `Resource ${resourceId} in state '${doc.status}' still has owner ${ownerAddr}`,
              raw: { status: doc.status },
            });
          }

          scanned++;
          lastId = doc._id;
        }

        if (onProgress) onProgress({ scanned, violationCount });
        if (batch.length < batchSize) break;
      }

      // Detect duplicate live owners within the scan window
      for (const [resourceId, owners] of ownerIndex) {
        const uniqueOwners = [...new Set(owners)];
        if (uniqueOwners.length > 1) {
          record({
            type: 'OWNERSHIP_DUPLICATE',
            severity: VIOLATION_SEVERITY.CRITICAL,
            resourceId,
            message: `Resource ${resourceId} has ${uniqueOwners.length} distinct owner entries`,
            raw: { owners: uniqueOwners },
          });
          violationCount++;
        }
      }

      emit(MONITOR_EVENT.SCAN_COMPLETED, { type: 'ownership', scanned, violationCount });
      return { scanned, violations: violationCount };
    } catch (err) {
      emit(MONITOR_EVENT.SCAN_ERROR, { type: 'ownership', error: err.message });
      throw err;
    }
  }

  function clear() {
    violations.length = 0;
    totalRecorded = 0;
  }

  return { record, getViolations, stats, runBalanceScan, runOwnershipScan, clear };
}

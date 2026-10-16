import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  getPartialFailures,
  detectUserActionRequirement,
  resolvePartialFailure,
  retryPartialFailure,
  PARTIAL_FAILURE_DOMAINS,
  PARTIAL_FAILURE_STATUSES,
  SEVERITIES,
} from "../../src/lib/backend/partialFailures.js";

function createMockDb(initialData = {}) {
  const store = {
    background_jobs: initialData.background_jobs ? [...initialData.background_jobs] : [],
    side_effect_outbox: initialData.side_effect_outbox ? [...initialData.side_effect_outbox] : [],
    indexer_deadletters: initialData.indexer_deadletters ? [...initialData.indexer_deadletters] : [],
    refunds: initialData.refunds ? [...initialData.refunds] : [],
    materials: initialData.materials ? [...initialData.materials] : [],
    audit_ledger: initialData.audit_ledger ? [...initialData.audit_ledger] : [],
  };

  return {
    _store: store,
    collection(name) {
      if (!store[name]) store[name] = [];
      const colDocs = store[name];
      return {
        find(query = {}) {
          const filtered = colDocs.filter((doc) => {
            for (const [key, val] of Object.entries(query)) {
              if (key === "$or" && Array.isArray(val)) {
                const matchAny = val.some((clause) => {
                  return Object.entries(clause).every(([k, v]) => {
                    if (v && typeof v === "object" && "$exists" in v) {
                      return v.$exists ? doc[k] !== undefined : doc[k] === undefined;
                    }
                    if (v && typeof v === "object" && "$regex" in v) {
                      return new RegExp(v.$regex, v.$options || "").test(doc[k]);
                    }
                    return doc[k] === v;
                  });
                });
                if (!matchAny) return false;
                continue;
              }
              if (val && typeof val === "object" && "$in" in val) {
                if (!val.$in.includes(doc[key])) return false;
                continue;
              }
              if (val && typeof val === "object" && "$gte" in val) {
                if (!(new Date(doc[key]) >= new Date(val.$gte))) return false;
                continue;
              }
              if (val && typeof val === "object" && "$lte" in val) {
                if (!(new Date(doc[key]) <= new Date(val.$lte))) return false;
                continue;
              }
              if (doc[key] !== val) return false;
            }
            return true;
          });

          let resultList = filtered;
          const cursor = {
            sort(sortCriteria) {
              const sortKey = Object.keys(sortCriteria)[0];
              const sortDir = sortCriteria[sortKey];
              resultList.sort((a, b) => {
                const valA = a[sortKey] || 0;
                const valB = b[sortKey] || 0;
                return sortDir === -1 ? (valB > valA ? 1 : -1) : (valA > valB ? 1 : -1);
              });
              return cursor;
            },
            limit(count) {
              resultList = resultList.slice(0, count);
              return cursor;
            },
            toArray: async () => resultList,
          };
          return cursor;
        },
        findOne: async (query = {}) => {
          return colDocs.find((doc) => {
            return Object.entries(query).every(([k, v]) => doc[k] === v);
          }) || null;
        },
        updateOne: async (query, update) => {
          const doc = colDocs.find((d) => Object.entries(query).every(([k, v]) => d[k] === v));
          if (!doc) return { matchedCount: 0, modifiedCount: 0 };
          if (update.$set) {
            Object.assign(doc, update.$set);
          }
          if (update.$inc) {
            for (const [k, v] of Object.entries(update.$inc)) {
              doc[k] = (doc[k] || 0) + v;
            }
          }
          return { matchedCount: 1, modifiedCount: 1 };
        },
        insertOne: async (doc) => {
          colDocs.push({ ...doc, _id: doc._id || `id-${Date.now()}-${Math.random()}` });
          return { acknowledged: true, insertedId: doc._id };
        },
      };
    },
  };
}

describe("Partial Failure Management & Operator Operations (#957)", () => {
  test("detects user-action-required errors accurately", () => {
    const insufficientFunds = detectUserActionRequirement(
      "WALLET_INSUFFICIENT_FUNDS: balance is 0.05 XLM, need 10 XLM"
    );
    assert.equal(insufficientFunds.required, true);
    assert.equal(insufficientFunds.reasonCode, "WALLET_INSUFFICIENT_FUNDS");
    assert.match(insufficientFunds.message, /fund wallet/i);

    const storageQuota = detectUserActionRequirement(
      "STORAGE_QUOTA_EXCEEDED: account limit 10GB reached"
    );
    assert.equal(storageQuota.required, true);
    assert.equal(storageQuota.reasonCode, "STORAGE_QUOTA_EXCEEDED");
    assert.match(storageQuota.message, /storage quota/i);

    const normalError = detectUserActionRequirement(
      "ECONNRESET: transient network socket hang up"
    );
    assert.equal(normalError.required, false);
    assert.equal(normalError.reasonCode, null);
    assert.equal(normalError.message, null);
  });

  test("aggregates partial failures across async_jobs, integrations, and user_operations", async () => {
    const mockDb = createMockDb({
      background_jobs: [
        {
          jobId: "job-101",
          type: "extract_archive",
          status: "failed",
          retryCount: 1,
          maxRetries: 3,
          error: "STORAGE_QUOTA_EXCEEDED: cannot write zip payload",
          createdAt: new Date("2026-10-15T10:00:00Z"),
          updatedAt: new Date("2026-10-15T10:05:00Z"),
        },
      ],
      side_effect_outbox: [
        {
          eventId: "outbox-202",
          type: "stellar_anchor_credit",
          status: "dead_letter",
          retryCount: 5,
          maxRetries: 5,
          lastError: "WALLET_INSUFFICIENT_FUNDS: anchor reserve depleted",
          createdAt: new Date("2026-10-15T11:00:00Z"),
          updatedAt: new Date("2026-10-15T11:10:00Z"),
        },
      ],
      indexer_deadletters: [
        {
          deadLetterId: "dl-303",
          cursor: "0192-3849",
          error: "SCHEMA_DESERIALIZATION_MISMATCH: version 4 missing fee field",
          resolved: false,
          createdAt: new Date("2026-10-15T12:00:00Z"),
        },
      ],
      refunds: [
        {
          refundId: "ref-404",
          status: "failed",
          failureReason: "PAYOUT_RECIPIENT_FROZEN",
          amount: 50,
          currency: "XLM",
          createdAt: new Date("2026-10-15T13:00:00Z"),
          updatedAt: new Date("2026-10-15T13:02:00Z"),
        },
      ],
      materials: [
        {
          materialId: "mat-505",
          importBatchId: "batch-999",
          quarantineReason: "MALFORMED_ARCHIVE_SIGNATURE",
          createdAt: new Date("2026-10-15T14:00:00Z"),
        },
      ],
    });

    const results = await getPartialFailures(mockDb, { limit: 50 });
    assert.equal(results.items.length, 5);
    assert.equal(results.summary.total, 5);
    assert.ok(results.summary.byDomain.async_jobs >= 1);
    assert.ok(results.summary.byDomain.integrations >= 2);
    assert.ok(results.summary.byDomain.user_operations >= 2);
    assert.ok(results.summary.requiresUserActionCount >= 2);

    const userActionItems = results.items.filter((i) => i.requiresUserAction);
    assert.ok(userActionItems.length >= 2);
  });

  test("filters partial failures by domain and requiresUserAction flag", async () => {
    const mockDb = createMockDb({
      background_jobs: [
        {
          jobId: "job-1",
          type: "indexer_sync",
          status: "failed",
          retryCount: 1,
          maxRetries: 3,
          error: "DATABASE_TIMEOUT",
        },
      ],
      side_effect_outbox: [
        {
          eventId: "outbox-1",
          type: "payment_webhook",
          status: "dead_letter",
          retryCount: 5,
          maxRetries: 5,
          lastError: "WALLET_INSUFFICIENT_FUNDS: balance low",
        },
      ],
    });

    const asyncOnly = await getPartialFailures(mockDb, { domain: PARTIAL_FAILURE_DOMAINS.ASYNC_JOBS });
    assert.equal(asyncOnly.items.length, 1);
    assert.equal(asyncOnly.items[0].failureId, "job_job-1");

    const userActionOnly = await getPartialFailures(mockDb, { requiresUserAction: true });
    assert.equal(userActionOnly.items.length, 1);
    assert.equal(userActionOnly.items[0].failureId, "outbox_outbox-1");
  });

  test("safely retries an eligible failed item and updates state", async () => {
    const mockDb = createMockDb({
      background_jobs: [
        {
          jobId: "job-retryable",
          type: "thumbnail_generate",
          status: "failed",
          retryCount: 1,
          maxRetries: 5,
          error: "TEMP_NETWORK_DISRUPTION",
          resolutionStatus: PARTIAL_FAILURE_STATUSES.UNRESOLVED,
        },
      ],
    });

    const retryResult = await retryPartialFailure(mockDb, "job_job-retryable", {
      actor: "admin-operator-1",
      reason: "dashboard_manual_retry",
    });

    assert.equal(retryResult.ok, true);
    assert.match(retryResult.message, /Retry successfully queued/);

    // Verify job in store updated
    const updatedJob = mockDb._store.background_jobs.find((j) => j.jobId === "job-retryable");
    assert.equal(updatedJob.status, "pending");
    assert.equal(updatedJob.resolutionStatus, PARTIAL_FAILURE_STATUSES.RETRYING);
  });

  test("rejects retry when user action is strictly required without resolution", async () => {
    const mockDb = createMockDb({
      side_effect_outbox: [
        {
          eventId: "outbox-locked",
          type: "storage_payout",
          status: "dead_letter",
          retryCount: 5,
          maxRetries: 5,
          lastError: "WALLET_INSUFFICIENT_FUNDS: reserve depleted",
          resolutionStatus: PARTIAL_FAILURE_STATUSES.UNRESOLVED,
        },
      ],
    });

    await assert.rejects(
      async () => {
        await retryPartialFailure(mockDb, "outbox_outbox-locked", {
          actor: "admin-operator-1",
        });
      },
      (err) => {
        assert.match(err.message, /cannot be safely auto-retried/);
        return true;
      }
    );
  });

  test("resolves an item with operator notes and state update", async () => {
    const mockDb = createMockDb({
      background_jobs: [
        {
          jobId: "job-resolve-me",
          type: "email_digest",
          status: "failed",
          resolutionStatus: PARTIAL_FAILURE_STATUSES.UNRESOLVED,
        },
      ],
    });

    const resolveResult = await resolvePartialFailure(mockDb, "job_job-resolve-me", {
      actor: "admin-operator-2",
      resolution: "resolved",
      note: "Email manually sent via support portal",
    });

    assert.equal(resolveResult.ok, true);
    assert.equal(resolveResult.status, PARTIAL_FAILURE_STATUSES.RESOLVED);

    const updatedJob = mockDb._store.background_jobs.find((j) => j.jobId === "job-resolve-me");
    assert.equal(updatedJob.resolutionStatus, PARTIAL_FAILURE_STATUSES.RESOLVED);
    assert.equal(updatedJob.resolvedBy, "admin-operator-2");
    assert.equal(updatedJob.resolutionNote, "Email manually sent via support portal");
  });
});

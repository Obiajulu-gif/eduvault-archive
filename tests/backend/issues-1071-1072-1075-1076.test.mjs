import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  StableErrorAuthorizationError,
  getOperatorRemediation,
  publicError,
  publicErrorCatalog,
  resolveStableError,
  validateStableErrorCatalog,
} from "../../src/lib/errors/stableCodes.js";
import {
  ResumableJobAuthorizationError,
  claimResumableJob,
  completeResumableJob,
  createResumableJob,
  failResumableJob,
  checkpointResumableJob,
  recoverDeadLetterJob,
  runResumableJob,
} from "../../src/lib/workers/resumableJob.js";
import {
  PermissionExportError,
  REDACTED_VALUE,
  RedactionAction,
  executePermissionAwareExport,
} from "../../src/lib/export/permissionAwareExport.js";
import { mulberry32 } from "../../test/concurrency/harness.js";

describe("Issues #1071, #1072, #1075, #1076 verification", () => {
  test("#1076 stable API error codes and authorized remediation hints", async () => {
    const pub = publicError("SETTLEMENT_UNAVAILABLE");
    assert.equal(pub.code, "SETTLEMENT_UNAVAILABLE");
    assert.equal(pub.status, 503);
    assert.equal(pub.retryable, true);
    assert.equal("remediationHints" in pub, false);

    const catalog = publicErrorCatalog();
    assert.ok(catalog.length > 10);
    assert.ok(catalog.every((e) => !("remediationHints" in e)));
    assert.deepEqual(validateStableErrorCatalog(), { valid: true, count: catalog.length, violations: [] });

    const fallback = resolveStableError(new Error("db secret=123"), { correlationId: "c-1" });
    assert.equal(fallback.code, "INTERNAL");
    assert.equal(fallback.correlationId, "c-1");

    await assert.rejects(
      () => getOperatorRemediation("SETTLEMENT_UNAVAILABLE", { actor: null }),
      (err) => err instanceof StableErrorAuthorizationError && err.status === 401,
    );
    await assert.rejects(
      () => getOperatorRemediation("SETTLEMENT_UNAVAILABLE", { actor: { id: "u1", role: "learner" } }),
      (err) => err instanceof StableErrorAuthorizationError && err.status === 403,
    );
    const adminHints = await getOperatorRemediation("SETTLEMENT_UNAVAILABLE", {
      actor: { id: "a1", role: "admin" },
    });
    assert.ok(adminHints.remediationHints.length > 0);
  });

  test("#1075 resumable jobs with checkpointing and dead-letter recovery", async () => {
    let job = createResumableJob({ name: "export", checkpoint: { offset: 0 }, maxAttempts: 2 });
    job = await runResumableJob(
      job,
      async ({ checkpoint }) => ({ done: false, checkpoint: { offset: checkpoint.offset + 10 } }),
      { maxBatches: 1 },
    );
    assert.equal(job.status, "paused");
    assert.deepEqual(job.checkpoint, { offset: 10 });

    let rollbackCount = 0;
    job = await runResumableJob(
      job,
      async () => {
        throw Object.assign(new Error("storage down"), { code: "STORAGE_UNAVAILABLE" });
      },
      { onRollback: async () => { rollbackCount += 1; } },
    );
    assert.equal(rollbackCount, 1);
    assert.equal(job.status, "dead_letter");

    await assert.rejects(
      () => recoverDeadLetterJob(job, { actor: { id: "u1", role: "learner" } }),
      ResumableJobAuthorizationError,
    );

    job = await recoverDeadLetterJob(job, {
      actor: { id: "op-1", role: "operator" },
      reason: "storage_restored",
    });
    assert.equal(job.status, "queued");
    assert.deepEqual(job.checkpoint, { offset: 10 });

    job = await runResumableJob(job, async ({ checkpoint }) => ({
      done: true,
      checkpoint: { offset: checkpoint.offset + 10 },
      result: { total: checkpoint.offset + 10 },
    }));
    assert.equal(job.status, "completed");
    assert.deepEqual(job.result, { total: 20 });

    // Preserve existing state machine helpers
    let manual = createResumableJob({ name: "m", checkpoint: { c: 0 } });
    manual = claimResumableJob(manual);
    manual = checkpointResumableJob(manual, { c: 5 });
    manual = failResumableJob(manual, new Error("temp"));
    assert.equal(manual.status, "paused");
    manual = claimResumableJob(manual);
    assert.equal(completeResumableJob(manual, { ok: true }).status, "completed");
  });

  test("#1072 permission-aware export with field redaction and retry", async () => {
    let fetched = false;
    await assert.rejects(
      () =>
        executePermissionAwareExport({
          actor: { id: "u1", role: "learner" },
          requiredPermission: "creator:analytics:read",
          fetchRecords: async () => {
            fetched = true;
            return [];
          },
        }),
      (err) => err instanceof PermissionExportError && err.status === 403,
    );
    assert.equal(fetched, false);

    let attempts = 0;
    const exported = await executePermissionAwareExport({
      actor: { id: "c1", role: "creator" },
      requiredPermission: "creator:analytics:read",
      generatedAt: "2026-11-18T12:00:00.000Z",
      fieldPolicies: {
        email: RedactionAction.MASK,
        walletAddress: RedactionAction.HASH,
        internalNotes: RedactionAction.REDACT,
      },
      fetchRecords: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("transient"), { code: "STORAGE_UNAVAILABLE", retryable: true });
        }
        return [
          {
            id: "r1",
            email: "learner@eduvault.org",
            walletAddress: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
            internalNotes: "private",
            apiToken: "secret_123",
          },
        ];
      },
    });

    assert.equal(exported.verification.attempts, 2);
    assert.equal(exported.records[0].email, "l***r@eduvault.org");
    assert.match(exported.records[0].walletAddress, /^pseudo_[a-f0-9]{16}$/);
    assert.equal(exported.records[0].internalNotes, REDACTED_VALUE);
    assert.equal(exported.records[0].apiToken, REDACTED_VALUE);
  });

  test("#1071 deterministic recovery for interrupted workflows", async () => {
    const runWorkflow = async (seed) => {
      const prng = mulberry32(seed);
      const items = ["a", "b", "c"];
      const applied = [];
      const trace = [];
      let step = 0;
      let job = createResumableJob({ name: "wf", checkpoint: { index: 0 }, maxAttempts: 4 });

      while (job.status === "queued" || job.status === "paused") {
        job = await runResumableJob(
          job,
          async (current, { checkpoint }) => {
            step += 1;
            trace.push({ step, attempt: current.attemptCount, index: checkpoint.index, r: prng() });
            if (step === 2) {
              throw Object.assign(new Error("interrupted"), { code: "STORAGE_UNAVAILABLE", retryable: true });
            }
            applied.push(items[checkpoint.index]);
            const next = checkpoint.index + 1;
            const done = next >= items.length;
            return { done, checkpoint: { index: next }, ...(done ? { result: { count: applied.length } } : {}) };
          },
          { maxBatches: 1 },
        );
      }
      return { job, applied, trace };
    };

    const runA = await runWorkflow(1337);
    const runB = await runWorkflow(1337);
    assert.equal(runA.job.status, "completed");
    assert.deepEqual(runA.applied, ["a", "b", "c"]);
    assert.deepEqual(runA.trace, runB.trace);
  });
});

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test, describe } from "node:test";
import { canonicalExternalEvidencePayload, verifyExternalEvidence } from "../../src/lib/backend/externalEvidence.js";
import { checkMigrationCompatibility } from "../../src/lib/migrations/compatibilityCheck.js";
import { RepairAuthorizationError, runResumableRepair } from "../../src/lib/maintenance/resumableRepairJob.js";
import { OperatorAuthorizationError, createDeadLetterOperator } from "../../src/lib/workers/deadLetterOperator.js";

function memoryDb(initial) {
  const collections = new Map(Object.entries(initial));
  return { collection(name) {
    const rows = collections.get(name) ?? [];
    collections.set(name, rows);
    return {
      async findOne(q) { return rows.find((row) => row._id === q._id) ?? null; },
      find(q) { const filtered = rows.filter((row) => (q._id?.$gt ? row._id > q._id.$gt : true)); return { sort: () => ({ limit: (n) => ({ toArray: async () => filtered.slice(0, n) }) }) }; },
      async replaceOne(q, value) { const i = rows.findIndex((row) => row._id === q._id); rows[i] = value; },
      async updateOne(q, update) { const i = rows.findIndex((row) => row._id === q._id); const value = { _id: q._id, ...(i >= 0 ? rows[i] : {}), ...update.$set }; if (i >= 0) rows[i] = value; else rows.push(value); },
      async countDocuments(q) { return rows.filter((row) => (q._id?.$gt ? row._id > q._id.$gt : true)).length; },
    };
  } };
}

describe("issue recovery controls", () => {
  test("repair resumes from a durable checkpoint and requires authorization", async () => {
    const db = memoryDb({ records: [{ _id: 1, broken: true }, { _id: 2, broken: true }, { _id: 3, broken: false }], repair_checkpoints: [] });
    await assert.rejects(() => runResumableRepair({ db, collectionName: "records", jobId: "repair", repair: () => ({ changed: false }), authorize: () => false }), RepairAuthorizationError);
    const result = await runResumableRepair({ db, collectionName: "records", jobId: "repair", batchSize: 1, maxBatches: 1, repair: (doc) => ({ changed: doc.broken, document: { ...doc, broken: false }, reason: "test" }), authorize: () => true });
    assert.equal(result.completed, false);
    const resumed = await runResumableRepair({ db, collectionName: "records", jobId: "repair", batchSize: 2, repair: (doc) => ({ changed: doc.broken, document: { ...doc, broken: false } }), authorize: () => true });
    assert.equal(resumed.completed, true);
    assert.equal((await db.collection("records").find({}).sort({}).limit(10).toArray())[0].broken, false);
  });

  test("verifies canonical external evidence and rejects tampering", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const evidence = { evidenceId: "ev-1", issuedAt: new Date().toISOString(), payload: { source: "partner", amount: 7 }, publicKey: publicKey.export({ type: "spki", format: "pem" }) };
    const signature = sign(null, Buffer.from(canonicalExternalEvidencePayload(evidence)), privateKey).toString("base64");
    const signed = { ...evidence, signature };
    assert.equal(verifyExternalEvidence(signed).valid, true);
    assert.equal(verifyExternalEvidence({ ...signed, payload: { source: "partner", amount: 8 } }).reason, "signature-mismatch");
  });

  test("requires an up/down validator for the next schema", () => {
    const schema = { latest: 1, migrations: { 2: { up: (record) => ({ ...record, schemaVersion: 2, flag: true }), down: (record) => ({ _id: record._id, schemaVersion: 1 }), validate: (record) => record.flag === true } } };
    assert.equal(checkMigrationCompatibility({ schema, records: [{ _id: "a", schemaVersion: 1 }] }).valid, true);
    assert.equal(checkMigrationCompatibility({ schema: { ...schema, migrations: {} } }).valid, false);
  });

  test("dead-letter inspection and retry are operator-authorized and auditable", async () => {
    const jobs = [{ jobId: "job-1", status: "dead_letter" }];
    const db = { collection: () => ({
      async findOne(query) { return jobs.find((job) => job.jobId === query.jobId) ?? null; },
      find() { return { sort: () => ({ skip: () => ({ limit: () => ({ toArray: async () => jobs, }) }) }) }; },
      async countDocuments() { return jobs.length; },
      async findOneAndUpdate(query, update) {
        const job = jobs.find((item) => item.jobId === query.jobId);
        if (!job || job.status !== "dead_letter") return null;
        Object.assign(job, update.$set);
        return job;
      },
    }) };
    const audit = [];
    const operator = createDeadLetterOperator({ db, authorize: (actor) => actor?.role === "operator", audit: (entry) => audit.push(entry) });
    await assert.rejects(() => operator.inspect({ role: "viewer" }, "job-1"), OperatorAuthorizationError);
    assert.equal((await operator.inspect({ id: "u1", role: "operator" }, "job-1")).jobId, "job-1");
    assert.equal((await operator.retry({ id: "u1", role: "operator" }, "job-1")).status, "pending");
    assert.deepEqual(audit.map((entry) => entry.action), ["dead-letter:inspect", "dead-letter:retry"]);
  });
});

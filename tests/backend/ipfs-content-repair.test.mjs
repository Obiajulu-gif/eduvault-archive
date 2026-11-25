import assert from "node:assert/strict";
import test from "node:test";
import {
  checkGatewayQuorum,
  rePinFromGateway,
  runIpfsContentRepairJob,
  validateIpfsRepairAuthorization,
  QuorumStatus,
  IPFS_REPAIR_AUDIT_COLLECTION,
  IPFS_REPAIR_QUARANTINE_COLLECTION,
} from "../../src/lib/storage/ipfsContentRepair.js";
import { createFakeMongo } from "../../src/lib/migrations/__tests__/fakeMongo.js";

const ADMIN_ACTOR = { id: "admin-storage", role: "admin" };
const UNAUTHORIZED_ACTOR = { id: "guest", role: "student" };

test("authorization: permits admin and storage:manage, blocks unauthorized actors", () => {
  assert.equal(validateIpfsRepairAuthorization(ADMIN_ACTOR), true);
  assert.equal(validateIpfsRepairAuthorization({ isCli: true }), true);
  assert.equal(validateIpfsRepairAuthorization({ permissions: ["storage:manage"] }), true);

  assert.throws(
    () => validateIpfsRepairAuthorization(null),
    (err) => err.code === "AUTH_UNAUTHENTICATED"
  );

  assert.throws(
    () => validateIpfsRepairAuthorization(UNAUTHORIZED_ACTOR),
    (err) => err.code === "AUTH_FORBIDDEN"
  );
});

test("checkGatewayQuorum: computes healthy, degraded, and unreachable quorum states", async () => {
  const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  const gateways = [
    "https://gw1.example/ipfs/",
    "https://gw2.example/ipfs/",
    "https://gw3.example/ipfs/",
  ];

  // 1. All healthy -> healthy
  const fetchAllOk = async () => ({ ok: true, status: 200, headers: new Map() });
  const resHealthy = await checkGatewayQuorum(cid, {
    gateways,
    requiredQuorum: 2,
    fetchImpl: fetchAllOk,
  });
  assert.equal(resHealthy.status, QuorumStatus.HEALTHY);
  assert.equal(resHealthy.healthy, true);
  assert.equal(resHealthy.healthyCount, 3);

  // 2. Only 1 healthy out of 3 -> degraded
  const fetchOneOk = async (url) => ({
    ok: url.includes("gw1"),
    status: url.includes("gw1") ? 200 : 504,
    headers: new Map(),
  });
  const resDegraded = await checkGatewayQuorum(cid, {
    gateways,
    requiredQuorum: 2,
    fetchImpl: fetchOneOk,
  });
  assert.equal(resDegraded.status, QuorumStatus.DEGRADED);
  assert.equal(resDegraded.healthy, false);
  assert.equal(resDegraded.healthyCount, 1);

  // 3. 0 healthy -> unreachable
  const fetchAllFail = async () => ({ ok: false, status: 404, headers: new Map() });
  const resUnreachable = await checkGatewayQuorum(cid, {
    gateways,
    requiredQuorum: 2,
    fetchImpl: fetchAllFail,
  });
  assert.equal(resUnreachable.status, QuorumStatus.UNREACHABLE);
  assert.equal(resUnreachable.healthy, false);
  assert.equal(resUnreachable.healthyCount, 0);
});

test("runIpfsContentRepairJob: dry-run mode identifies degraded and unreachable items without writes", async () => {
  const db = createFakeMongo();
  db.seed(
    "materials",
    { _id: "m-healthy", title: "Healthy Doc", storageKey: "cid-healthy" },
    { _id: "m-degraded", title: "Degraded Doc", storageKey: "cid-degraded" },
    { _id: "m-unreachable", title: "Dead Doc", storageKey: "cid-dead" }
  );

  const gateways = ["https://gw1/ipfs/", "https://gw2/ipfs/"];
  const fetchMock = async (url) => {
    if (url.includes("cid-healthy")) return { ok: true, status: 200 };
    if (url.includes("cid-degraded")) return { ok: url.includes("gw1"), status: url.includes("gw1") ? 200 : 502 };
    return { ok: false, status: 404 };
  };

  const summary = await runIpfsContentRepairJob(db, {
    dryRun: true,
    gateways,
    requiredQuorum: 2,
    fetchImpl: fetchMock,
    actor: ADMIN_ACTOR,
  });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.scanned, 3);
  assert.equal(summary.healthy, 1);
  assert.equal(summary.degraded, 1);
  assert.equal(summary.unreachable, 1);
  assert.equal(summary.repaired, 0);
  assert.equal(summary.quarantined, 0);
});

test("runIpfsContentRepairJob: apply mode repairs degraded CID and quarantines unreachable CID", async () => {
  const db = createFakeMongo();
  db.seed(
    "materials",
    { _id: "m-degraded", title: "Degraded Doc", storageKey: "cid-degraded" },
    { _id: "m-unreachable", title: "Dead Doc", storageKey: "cid-dead" }
  );

  const gateways = ["https://gw1/ipfs/", "https://gw2/ipfs/"];
  const mockProviders = [
    {
      name: "secondary-pin",
      pinFile: async () => ({ cid: "cid-degraded" }),
    },
  ];

  const fetchMock = async (url) => {
    if (url.includes("cid-degraded")) {
      return {
        ok: url.includes("gw1"),
        status: url.includes("gw1") ? 200 : 502,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]),
      };
    }
    return { ok: false, status: 404 };
  };

  const summary = await runIpfsContentRepairJob(db, {
    dryRun: false,
    gateways,
    providers: mockProviders,
    requiredQuorum: 2,
    fetchImpl: fetchMock,
    actor: ADMIN_ACTOR,
  });

  assert.equal(summary.dryRun, false);
  assert.equal(summary.repaired, 1);
  assert.equal(summary.quarantined, 1);

  // Quarantine collection must have record for dead CID
  const quarantineColl = db.collection(IPFS_REPAIR_QUARANTINE_COLLECTION);
  const deadDoc = await quarantineColl.findOne({ cid: "cid-dead" });
  assert.ok(deadDoc);
  assert.equal(deadDoc.status, "unreachable");

  // Audit record must be saved
  const auditColl = db.collection(IPFS_REPAIR_AUDIT_COLLECTION);
  const auditDoc = await auditColl.findOne({ runId: summary.runId });
  assert.ok(auditDoc);
  assert.equal(auditDoc.repaired, 1);
  assert.equal(auditDoc.quarantined, 1);
});

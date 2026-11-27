import assert from "node:assert/strict";
import test from "node:test";
import {
  validateAuditorAuthorization,
  verifyProvenanceIntegrity,
  getAuditorProvenanceAndEntitlements,
} from "../../src/lib/audit/auditorViewService.js";
import {
  buildImportProvenance,
  buildDerivedProvenance,
  PROVENANCE_KINDS,
  provenanceToCsv,
} from "../../src/lib/backend/provenance.js";
import { createFakeMongo } from "../../src/lib/migrations/__tests__/fakeMongo.js";

const ADMIN_ACTOR = { id: "admin-1", role: "admin" };
const AUDITOR_ACTOR = { id: "auditor-1", role: "auditor" };
const COMPLIANCE_ACTOR = { id: "comp-1", role: "compliance_officer" };
const PERMITTED_ACTOR = { id: "user-1", permissions: ["audit:read"] };
const UNAUTHORIZED_ACTOR = { id: "learner-1", role: "learner" };

test("authorization: allows admin, auditor, compliance_officer, and audit:read; blocks others", () => {
  assert.equal(validateAuditorAuthorization(ADMIN_ACTOR), true);
  assert.equal(validateAuditorAuthorization(AUDITOR_ACTOR), true);
  assert.equal(validateAuditorAuthorization(COMPLIANCE_ACTOR), true);
  assert.equal(validateAuditorAuthorization(PERMITTED_ACTOR), true);

  assert.throws(
    () => validateAuditorAuthorization(null),
    (err) => err.code === "AUTH_UNAUTHENTICATED"
  );

  assert.throws(
    () => validateAuditorAuthorization(UNAUTHORIZED_ACTOR),
    (err) => err.code === "AUTH_FORBIDDEN"
  );
});

test("provenance integrity: detects intact vs broken ancestry chains", async () => {
  const recordsIntact = [
    { _id: "m-orig", title: "Original Math" },
    {
      _id: "m-deriv",
      title: "Derived Algebra",
      provenance: {
        kind: PROVENANCE_KINDS.DERIVED,
        origin: { materialId: "m-orig" },
      },
    },
  ];

  const sourceResolver = async (id) => (id === "m-orig" ? { _id: "m-orig", title: "Original Math" } : null);
  const resultIntact = await verifyProvenanceIntegrity(recordsIntact, sourceResolver);
  assert.equal(resultIntact.verified, true);
  assert.equal(resultIntact.brokenChains, 0);

  // Broken derived record missing parent materialId
  const recordsBroken = [
    {
      _id: "m-broken",
      title: "Broken Derivative",
      provenance: {
        kind: PROVENANCE_KINDS.DERIVED,
        origin: { materialId: null },
      },
    },
  ];
  const resultBroken = await verifyProvenanceIntegrity(recordsBroken, sourceResolver);
  assert.equal(resultBroken.verified, false);
  assert.equal(resultBroken.brokenChains, 1);
});

test("getAuditorProvenanceAndEntitlements: fetches joined provenance and entitlement audit trail", async () => {
  const db = createFakeMongo();

  const importProv = buildImportProvenance({
    importBatchId: "batch-2026-01",
    sourceName: "curriculum.csv",
    format: "csv",
    recordIndex: 0,
    actorAddress: "0x1111",
  });

  db.seed(
    "materials",
    {
      _id: "mat-import-1",
      title: "Imported Biology",
      price: 15,
      provenance: importProv,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
    },
    {
      _id: "mat-direct-1",
      title: "Direct Calculus",
      price: 25,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
    }
  );

  db.seed(
    "entitlement_cache",
    {
      _id: "ent-1",
      materialId: "mat-import-1",
      buyerAddress: "0x2222",
      active: true,
      grantedAt: new Date("2026-01-03"),
      txHash: "tx-stellar-001",
    },
    {
      _id: "ent-2",
      materialId: "mat-import-1",
      buyerAddress: "0x3333",
      active: false,
      grantedAt: new Date("2026-01-04"),
      revokedAt: new Date("2026-01-05"),
      revokedReason: "refund_processed",
    }
  );

  const report = await getAuditorProvenanceAndEntitlements(db, {
    materialId: "mat-import-1",
  });

  assert.equal(report.meta.scannedMaterials, 1);
  assert.equal(report.provenance.rows.length, 1);
  assert.equal(report.provenance.rows[0].provenanceKind, "import");
  assert.equal(report.provenance.rows[0].importBatchId, "batch-2026-01");

  assert.equal(report.entitlements.totalCount, 2);
  assert.equal(report.entitlements.activeCount, 1);
  assert.equal(report.entitlements.revokedCount, 1);

  const revoked = report.entitlements.rows.find((e) => e.status === "revoked");
  assert.ok(revoked);
  assert.equal(revoked.revokedReason, "refund_processed");
});

test("filtering: scopes by buyerAddress and provenance kind", async () => {
  const db = createFakeMongo();

  db.seed(
    "materials",
    {
      _id: "m-1",
      title: "Book 1",
      provenance: { kind: "import", origin: { importBatchId: "b1" } },
    },
    {
      _id: "m-2",
      title: "Book 2",
      provenance: { kind: "derived", origin: { materialId: "m-1" } },
    }
  );

  db.seed(
    "entitlement_cache",
    { _id: "e1", materialId: "m-1", buyerAddress: "alice" },
    { _id: "e2", materialId: "m-1", buyerAddress: "bob" }
  );

  const kindFilterReport = await getAuditorProvenanceAndEntitlements(db, { kind: "import" });
  assert.equal(kindFilterReport.provenance.rows.length, 1);
  assert.equal(kindFilterReport.provenance.rows[0].materialId, "m-1");

  const buyerFilterReport = await getAuditorProvenanceAndEntitlements(db, { buyerAddress: "alice" });
  assert.equal(buyerFilterReport.entitlements.rows.length, 1);
  assert.equal(buyerFilterReport.entitlements.rows[0].buyerAddress, "alice");
});

test("export: generates valid CSV from provenance rows", async () => {
  const rows = [
    {
      materialId: "m1",
      title: "Test Title",
      provenanceKind: "import",
      importBatchId: "batch-1",
      actorAddress: "0xabc",
      revisionCount: 2,
      transformVersion: "import@1",
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  const csv = provenanceToCsv(rows);
  assert.ok(csv.includes("materialId,title,userAddress,provenanceKind"));
  assert.ok(csv.includes("m1,Test Title"));
  assert.ok(csv.includes("import"));
});

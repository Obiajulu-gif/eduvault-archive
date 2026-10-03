export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { requirePermission } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import { randomUUID } from "node:crypto";
import { validateImportPayload, planImport, publicPlanRows, ImportValidationError } from "@/lib/backend/materialImport";
import { buildMaterialHistoryEntry } from "@/lib/backend/schemaContracts";
import { buildImportProvenance, recordProvenanceRevision, TRANSFORM_VERSIONS } from "@/lib/backend/provenance";
import { sanitizeString } from "@/lib/api/validation";
import { invalidateCatalogCache } from "@/lib/cache/redis";
import { notify } from "@/lib/notifications/notifications";
import { assertActorQuota, consumeActorQuota, UserQuotaError } from "@/lib/quotaManager";

export const runtime = "nodejs";

// POST /api/materials/import
// Bulk import materials from JSON payload. Dry run (body.dryRun, default
// true) returns the create/update/skip/error plan without writing anything.
// See docs/material-import.md.
export async function POST(request) {
  return withApiHardening(
    request,
    { route: "materials-import", rateLimit: { limit: 10, windowMs: 60_000 } },
    async () => {
      try {
        const authorization = await requirePermission(request, "creator:manage");
        if (!authorization.ok) {
          auditLog({ event: "auth_failed", route: "materials-import", method: "POST", status: authorization.status });
          return NextResponse.json({ error: "Creator access required" }, { status: authorization.status });
        }
        const user = authorization.user;

        let userAddress = user.walletAddress || user.address || null;
        if (!userAddress && user.sub) {
          try {
            const { ObjectId } = await import("mongodb");
            const dbUser = await (await getDb()).collection("users").findOne({ _id: new ObjectId(user.sub) });
            userAddress = dbUser?.walletAddress || dbUser?.walletAddressLower || null;
          } catch (e) {
            console.warn("User lookup failed during import:", e?.message || e);
          }
        }

        if (!userAddress) {
          return NextResponse.json({ error: "No wallet address associated with account" }, { status: 400 });
        }

        const body = await request.json();
        const validation = validateImportPayload(body);

        // Planning only reads: dry runs stop before any write below.
        const db = await getDb();
        const materials = db.collection("materials");
        const externalIds = validation.validRecords.map((r) => r.externalId).filter(Boolean);
        const storageKeys = validation.validRecords.map((r) => r.storageKey);
        const existing = await materials
          .find({ userAddress, $or: [{ externalId: { $in: externalIds } }, { storageKey: { $in: storageKeys } }] })
          .toArray();
        const plan = planImport(validation, existing);
        // valid/invalid/invalidRows predate the plan and are kept for existing
        // clients (BulkMaterialReview); invalidRows now also carries in-batch
        // duplicates.
        const invalidRows = plan.rows
          .filter((r) => r.action === "error")
          .map(({ row, errors }) => ({ row, errors }));
        const report = {
          dryRun: validation.dryRun,
          total: validation.total,
          valid: validation.total - invalidRows.length,
          invalid: invalidRows.length,
          invalidRows,
          summary: plan.summary,
          rows: publicPlanRows(plan.rows),
        };

        if (validation.dryRun) {
          return NextResponse.json(
            { ...report, message: "Dry run: no records were written" },
            { status: invalidRows.length > 0 ? 400 : 200 }
          );
        }

        // Validation is all-or-nothing: a bad row blocks the whole commit so a
        // file is never half-applied because of a typo.
        if (plan.summary.error > 0) {
          return NextResponse.json({
            ...report,
            message: `${plan.summary.error} row(s) have errors. Nothing was written. Fix the listed rows and re-run.`,
          }, { status: 400 });
        }

        const writeRows = plan.rows.filter((r) => r.action === "create" || r.action === "update");
        if (writeRows.length === 0) {
          return NextResponse.json({ ...report, imported: 0, created: 0, updated: 0, message: "Nothing to write: every row is already imported" });
        }

        // Dry runs return above without consuming resources. A committed import
        // reserves compute and indexing capacity for each create/update row.
        try {
          await assertActorQuota(db, userAddress, "compute", writeRows.length);
          await assertActorQuota(db, userAddress, "indexing", writeRows.length);
          await consumeActorQuota(db, userAddress, "compute", writeRows.length);
          await consumeActorQuota(db, userAddress, "indexing", writeRows.length);
        } catch (quotaError) {
          if (!(quotaError instanceof UserQuotaError)) throw quotaError;
          return NextResponse.json({ error: quotaError.message, resource: quotaError.resource }, { status: 429 });
        }

        const now = new Date();
        const importBatchId = randomUUID();
        const quarantineCol = db.collection("quarantine");

        // A stable human-readable label for the import source, so a maintainer
        // reading provenance can tell which file/sheet a batch came from.
        const sourceName = sanitizeString(body?.sourceName || body?.fileName, { maxLength: 256 }) || null;

        const buildCreateDoc = async (record, rowNumber) => {
          const contentHash = record.storageKey || record.fileUrl || record.ipfsCid;
          let quarantineState = "pending";
          let contentManifestHash = null;
          let contentManifestGeneration = null;

          if (contentHash) {
            const existingQuarantine = await quarantineCol.findOne({ contentHash });
            if (existingQuarantine && existingQuarantine.state === "clean") {
              quarantineState = "clean";
              contentManifestHash = existingQuarantine.manifestHash || null;
              contentManifestGeneration = existingQuarantine.manifestGeneration || null;
            } else if (!existingQuarantine) {
              try {
                const { createQuarantineRecord } = await import("@/lib/publishing/quarantine");
                await createQuarantineRecord({
                  db,
                  contentHash,
                  fileName: record.title || contentHash,
                  mimeType: "application/octet-stream",
                  sizeBytes: 0,
                  uploaderAddress: userAddress,
                });
              } catch (e) {
                // Duplicate key race or quarantine creation non-fatal error
              }
            } else {
              quarantineState = existingQuarantine.state || "pending";
            }
          }

          const provenance = buildImportProvenance({
            importBatchId,
            format: validation.format,
            sourceName,
            recordIndex: rowNumber,
            externalId: record.externalId || null,
            actorAddress: userAddress,
            actorUserId: user.sub || null,
            now,
          });

          const { externalId, ...fields } = record;
          return {
            ...fields,
            ...(externalId ? { externalId } : {}),
            provenance,
            userAddress,
            importBatchId,
            quarantineState,
            contentManifestHash,
            contentManifestGeneration,
            createdAt: now,
            updatedAt: now,
          };
        };

        // Attach/append provenance once per updated row and reuse it for the
        // write and the history entry, so both agree exactly.
        for (const r of writeRows) {
          if (r.action !== "update") continue;
          r.nextProvenance = r.previous?.provenance
            ? recordProvenanceRevision(r.previous.provenance, {
              actorAddress: userAddress,
              actorUserId: user.sub || null,
              importBatchId,
              changedFields: r.fields,
              source: "import",
              now,
            })
            // Records created before provenance existed still get an origin
            // the first time an import touches them, rather than staying dark.
            : buildImportProvenance({
              importBatchId,
              format: validation.format,
              sourceName,
              recordIndex: r.row,
              externalId: r.externalId || null,
              actorAddress: userAddress,
              actorUserId: user.sub || null,
              now,
            });
        }

        const ops = await Promise.all(writeRows.map(async (r) => (r.action === "create"
          ? { insertOne: { document: await buildCreateDoc(r.record, r.row) } }
          : {
            updateOne: {
              filter: { userAddress, externalId: r.externalId },
              update: {
                $set: {
                  ...Object.fromEntries(r.fields.map((f) => [f, r.record[f]])),
                  provenance: r.nextProvenance,
                  lastImportBatchId: importBatchId,
                  updatedAt: now,
                },
              },
            },
          })));

        let created = 0;
        let updated = 0;
        let failedOps = [];
        try {
          const result = await materials.bulkWrite(ops, { ordered: false });
          created = result.insertedCount;
          updated = result.modifiedCount;
        } catch (writeErr) {
          if (!writeErr.result || !writeErr.writeErrors) throw writeErr;
          created = writeErr.result.insertedCount;
          updated = writeErr.result.modifiedCount;
          failedOps = [].concat(writeErr.writeErrors);
        }

        const failedIndexes = new Set(failedOps.map((e) => e.index));
        const failedRows = failedOps.map((e) => ({
          row: writeRows[e.index].row,
          action: writeRows[e.index].action,
          code: e.code,
          message: e.code === 11000 ? "externalId already imported by a concurrent request" : (e.errmsg || e.message),
        }));

        // Record prior values so an import update can be reverted by hand.
        const historyEntries = writeRows
          .filter((r, i) => r.action === "update" && !failedIndexes.has(i))
          .map((r) => ({
            ...buildMaterialHistoryEntry({
              materialId: r.materialId,
              previousDoc: r.previous,
              update: {},
              updatedBy: userAddress,
              changeReason: `import ${importBatchId}`,
              source: "import",
            }),
            changes: Object.fromEntries(r.fields.map((f) => [f, { from: r.previous[f] ?? null, to: r.record[f] }])),
            provenance: {
              kind: "import",
              importBatchId,
              transformVersion: TRANSFORM_VERSIONS.import,
            },
          }));
        if (historyEntries.length > 0) {
          await db.collection("material_history").insertMany(historyEntries);
        }
        if (created + updated > 0) await invalidateCatalogCache();

        const partial = failedRows.length > 0;
        try {
          await notify(db, {
            recipient: user.sub,
            type: partial ? "import_partial_failure" : "import_completed",
            dedupeKey: `import:${importBatchId}`,
            title: partial ? "Import partially failed" : "Import completed",
            message: `${created} created, ${updated} updated, ${plan.summary.skip} skipped${partial ? `, ${failedRows.length} failed` : ""}.`,
            link: "/dashboard/my-materials",
          });
        } catch (e) {
          console.warn("Import notification failed:", e?.message || e);
        }

        auditLog({
          event: "materials_imported",
          route: "materials-import",
          method: "POST",
          status: 201,
          actor: user.sub,
          importBatchId,
          created,
          updated,
          failed: failedRows.length,
        });

        return NextResponse.json({
          ...report,
          importBatchId,
          imported: created + updated,
          created,
          updated,
          failedRows,
          rollback: {
            importBatchId,
            created: `Undo creates by deleting materials with importBatchId "${importBatchId}".`,
            updated: `Prior values of updated materials are in material_history with changeReason "import ${importBatchId}".`,
            retry: "Fix failedRows and re-run the same file; rows with an externalId that already succeeded are skipped.",
          },
        }, { status: !partial ? 201 : created + updated > 0 ? 207 : 500 });
      } catch (err) {
        if (err instanceof UserQuotaError) {
          return NextResponse.json({ error: err.message, resource: err.resource }, { status: 429 });
        }
        if (err instanceof ImportValidationError) {
          return NextResponse.json({ error: err.message, details: err.details }, { status: 400 });
        }
        if (err.name === "ValidationError") throw err;
        auditLog({ event: "materials_import_failed", route: "materials-import", method: "POST", status: 500, reason: err.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

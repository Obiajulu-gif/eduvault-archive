export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { validateMaterialPayload, validateMaterialUpdatePayload, validateChangeReason, validateExpectedVersion } from "@/lib/api/validation";
import { requirePermission } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { buildMaterialHistoryEntry, EDITABLE_MATERIAL_FIELDS } from "@/lib/backend/schemaContracts";
import { enqueueMaterialSearchProjection } from "@/lib/backend/materialSearchProjection";
import { evaluateAndQueueListing } from "@/lib/backend/manipulationScoring";
import { invalidateCatalogCache } from "@/lib/cache/redis";
import { appendCriticalMutation } from "@/lib/backend/auditLedger";

export const runtime = "nodejs";

// Resolve the source of a derived record by id first, then by the creator's
// external id, so a derivative can be attached to a record regardless of
// which handle the caller knows.
async function findDerivedSource(db, derivedFrom = {}) {
  const materials = db.collection("materials");
  if (derivedFrom.materialId && ObjectId.isValid(derivedFrom.materialId)) {
    return materials.findOne({ _id: new ObjectId(derivedFrom.materialId) });
  }
  if (derivedFrom.externalId) {
    return materials.findOne({ externalId: derivedFrom.externalId });
  }
  return null;
}

function sanitizeMaterial(doc) {
  if (!doc) return doc;
  const { storageKey, fileUrl, metadataUrl, ...safe } = doc;
  return safe;
}

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "materials", rateLimit: { limit: 40, windowMs: 60_000 } },
    async () => {
      try {
        const authorization = await requirePermission(request, "creator:manage");
        if (!authorization.ok) {
          auditLog({ event: "auth_failed", route: "materials", method: "POST", status: authorization.status });
          return NextResponse.json({ error: "Creator access required" }, { status: authorization.status });
        }
        const user = authorization.user;

        // #803: an older client may pin the shape it knows via X-Schema-Version.
        const negotiation = negotiateSchemaVersion(request, "materials");
        const material = validateMaterialPayload(await request.json());

        const db = await getDb();

        let userAddress = user.walletAddress || user.address || null;
        if (!userAddress && user.sub) {
          try {
            const dbUser = await db.collection("users").findOne({ _id: new ObjectId(user.sub) });
            userAddress = dbUser?.walletAddress || dbUser?.walletAddressLower || null;
          } catch (e) {
            console.warn("User lookup failed while creating material:", e?.message || e);
          }
        }

        // A record created from another listing carries derived provenance so
        // maintainers can walk back to the source (even after it is deleted).
        let provenance = null;
        if (material.derivedFrom) {
          const source = await findDerivedSource(db, material.derivedFrom);
          if (!source) {
            return NextResponse.json({ error: "Source material for derivedFrom was not found" }, { status: 400 });
          }
          provenance = buildDerivedProvenance({
            sourceMaterialId: String(source._id),
            sourceExternalId: source.externalId || material.derivedFrom.externalId || null,
            relation: material.derivedFrom.relation,
            actorAddress: userAddress,
            actorUserId: user.sub || null,
          });
        }

        const doc = {
          userAddress,
          ...material,
          ...(provenance ? { provenance } : {}),
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await db.collection("materials").insertOne(doc);
        const assessment = await evaluateAndQueueListing(db, { _id: result.insertedId, ...doc });
        await enqueueMaterialSearchProjection({
          db,
          material: { _id: result.insertedId, ...doc, ...(assessment.flagged ? { moderationStatus: "pending_review" } : {}) },
          reason: "material_created",
        });
        await invalidateCatalogCache();
        auditLog({ event: "material_created", route: "materials", method: "POST", status: 201, actor: user.sub });
        return NextResponse.json(
          { success: true, materialId: result.insertedId, ...sanitizeMaterial(doc) },
          { status: 201, headers: schemaResponseHeaders("materials", negotiation.version) }
        );
      } catch (err) {
        if (err.name === "ValidationError") throw err;
        if (err instanceof UnsupportedSchemaVersionError) {
          return NextResponse.json({ error: err.message, collection: err.collection, latest: err.latest }, { status: 400 });
        }
        auditLog({ event: "material_create_failed", route: "materials", method: "POST", status: 500, reason: err.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "materials", rateLimit: { limit: 80, windowMs: 60_000 } },
    async () => {
      try {
        const authorization = await requirePermission(request, "creator:manage");
        if (!authorization.ok) {
          auditLog({ event: "auth_failed", route: "materials", method: "GET", status: authorization.status });
          return NextResponse.json({ error: "Creator access required" }, { status: authorization.status });
        }
        const user = authorization.user;

        // #803: legacy documents are upgraded in-memory to the requested
        // shape, so old records stay readable before a backfill reaches them.
        const negotiation = negotiateSchemaVersion(request, "materials");
        const db = await getDb();
        const userAddress = user.walletAddress || user.address || user.id;
        const items = await db
          .collection("materials")
          .find({ userAddress })
          .sort({ createdAt: -1 })
          .toArray();

        const normalized = items.map((doc) =>
          readRecord("materials", sanitizeMaterial(doc), { targetVersion: negotiation.version })
        );
        return NextResponse.json(normalized, { headers: schemaResponseHeaders("materials", negotiation.version) });
      } catch (err) {
        if (err.name === "ValidationError") throw err;
        if (err instanceof UnsupportedSchemaVersionError) {
          return NextResponse.json({ error: err.message, collection: err.collection, latest: err.latest }, { status: 400 });
        }
        auditLog({ event: "material_list_failed", route: "materials", method: "GET", status: 500, reason: err.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

export async function PUT(request) {
  return withApiHardening(
    request,
    { route: "materials", rateLimit: { limit: 40, windowMs: 60_000 } },
    async () => {
      try {
        const authorization = await requirePermission(request, "creator:manage");
        if (!authorization.ok) {
          auditLog({ event: "auth_failed", route: "materials", method: "PUT", status: authorization.status });
          return NextResponse.json({ error: "Creator access required" }, { status: authorization.status });
        }
        const user = authorization.user;

        const url = new URL(request.url);
        const materialId = url.searchParams.get("id");
        if (!materialId || !ObjectId.isValid(materialId)) {
          return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
        }

        const body = await request.json();
        const updates = validateMaterialUpdatePayload(body);
        const changeReason = validateChangeReason(body.changeReason);
        const expectedVersion = validateExpectedVersion(
          body.expectedVersion ?? body.version ?? request.headers.get("if-match")?.replace(/["\s]/g, '')
        );

        const db = await getDb();
        const userAddress = user.walletAddress || user.address || user.id;

        const existing = await db.collection("materials").findOne({ _id: new ObjectId(materialId) });
        if (!existing) {
          return NextResponse.json({ error: "Material not found" }, { status: 404 });
        }

        const isOwner =
          existing.userAddress === userAddress ||
          (existing.userAddress && userAddress && existing.userAddress.toLowerCase() === userAddress.toLowerCase());
        const isAdmin = user.role === "admin" || user.isAdmin === true;

        if (!isOwner && !isAdmin) {
          auditLog({ event: "material_update_forbidden", route: "materials", method: "PUT", status: 403, actor: user.sub });
          return NextResponse.json({ error: "Forbidden: not the material owner" }, { status: 403 });
        }

        // Avoid incrementing the material version (and creating misleading
        // evidence) when a client retries the values already persisted.
        const hasChange = Object.keys(updates).some(
          (key) => JSON.stringify(existing[key] ?? null) !== JSON.stringify(updates[key] ?? null),
        );
        if (!hasChange) {
          return NextResponse.json({ error: "No material values changed" }, { status: 409 });
        }

        const now = new Date();
        const nextVersion = (existing.version || 1) + 1;
        // Preserve the immutable origin and append a revision, so an edit can
        // never rewrite where the record came from.
        const provenance = existing.provenance
          ? recordProvenanceRevision(existing.provenance, {
            actorAddress: userAddress,
            actorUserId: user.sub || null,
            changedFields: Object.keys(updates),
            source: "creator",
            now,
          })
          : undefined;
        const updateDoc = {
          ...updates,
          ...(provenance ? { provenance } : {}),
          updatedAt: now,
          updatedBy: userAddress,
          version: nextVersion,
          searchVersion: nextVersion,
        };

        const result = await db.collection("materials").findOneAndUpdate(
          filter,
          { $set: updateDoc },
          { returnDocument: "after" }
        );

        const updatedMaterial = result?.value || result;

        if (!updatedMaterial) {
          // Concurrently updated by another writer between findOne and findOneAndUpdate
          const fresh = await db.collection("materials").findOne({ _id: new ObjectId(materialId) });
          if (!fresh) {
            return NextResponse.json({ error: "Material not found" }, { status: 404 });
          }
          auditLog({
            event: "material_update_conflict",
            route: "materials",
            method: "PUT",
            status: 409,
            actor: user.sub,
            materialId,
            currentVersion: fresh.version || 1,
            expectedVersion: currentVersion,
          });
          return NextResponse.json(
            {
              error: "Conflict: This listing has been modified by another session. Please reload to see the latest changes.",
              code: "CONCURRENCY_CONFLICT",
              currentVersion: fresh.version || 1,
              expectedVersion: currentVersion,
              conflictFields: Object.keys(updates),
            },
            { status: 409 }
          );
        }

        const assessment = await evaluateAndQueueListing(db, updatedMaterial, { now });
        if (assessment.flagged) updatedMaterial.moderationStatus = "pending_review";
        await enqueueMaterialSearchProjection({
          db,
          material: updatedMaterial,
          reason: "material_updated",
          now,
        });

        const historyEntry = buildMaterialHistoryEntry({
          materialId,
          previousDoc: existing,
          update: updates,
          updatedBy: userAddress,
          changeReason,
          source: isAdmin ? "admin" : "creator",
        });

        await db.collection("material_history").insertOne(historyEntry);
        await appendCriticalMutation({
          db,
          operationId: `material.update:${materialId}:${nextVersion}`,
          actor: userAddress,
          actorContext: { userId: user.sub || null },
          action: "material.access_terms_updated",
          target: { type: "material", id: materialId },
          reason: changeReason || "Creator material update",
          // `updates` is validated and limited to editable metadata, so no
          // storage credentials or private file locations enter the ledger.
          before: Object.fromEntries(Object.keys(updates).map((key) => [key, existing[key] ?? null])),
          after: updates,
          intent: { source: "creator", fields: Object.keys(updates).sort() },
        });
        await invalidateCatalogCache();

        auditLog({ event: "material_updated", route: "materials", method: "PUT", status: 200, actor: user.sub, materialId });
        return NextResponse.json(sanitizeMaterial(updatedMaterial));
      } catch (err) {
        if (err.name === "ValidationError") throw err;
        auditLog({ event: "material_update_failed", route: "materials", method: "PUT", status: 500, reason: err.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

export async function PATCH(request) {
  return PUT(request);
}

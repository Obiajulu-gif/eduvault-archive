export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { validateMaterialPayload, validateMaterialUpdatePayload, validateChangeReason, normalizeWalletAddress } from "@/lib/api/validation";
import { getUserFromCookie } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { buildMaterialHistoryEntry, EDITABLE_MATERIAL_FIELDS } from "@/lib/backend/schemaContracts";

export const runtime = "nodejs";

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
        const user = await getUserFromCookie(request);
        if (!user) {
          auditLog({ event: "auth_failed", route: "materials", method: "POST", status: 401 });
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const material = validateMaterialPayload(await request.json());

        const db = await getDb();

        let rawUserAddress = user.walletAddress || user.address || user.activeWalletAddress || null;
        if (!rawUserAddress && user.sub) {
          try {
            const dbUser = await db.collection("users").findOne({ _id: new ObjectId(user.sub) });
            rawUserAddress = dbUser?.walletAddress || dbUser?.walletAddressLower || null;
          } catch (e) {
            console.warn("User lookup failed while creating material:", e?.message || e);
          }
        }

        let userAddress = null;
        if (rawUserAddress) {
          try {
            userAddress = normalizeWalletAddress(rawUserAddress);
          } catch {
            userAddress = null;
          }
        }

        if (!userAddress) {
          auditLog({ event: "material_create_unauthorized_wallet", route: "materials", method: "POST", status: 400, actor: user.sub });
          return NextResponse.json(
            { error: "Uploader wallet address is required and must be verified" },
            { status: 400 }
          );
        }

        const doc = {
          userAddress,
          userAddressLower: userAddress.toLowerCase(),
          ...material,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await db.collection("materials").insertOne(doc);
        auditLog({ event: "material_created", route: "materials", method: "POST", status: 201, actor: user.sub });
        return NextResponse.json({ success: true, materialId: result.insertedId, ...sanitizeMaterial(doc) }, { status: 201 });
      } catch (err) {
        if (err.name === "ValidationError") throw err;
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
        const user = await getUserFromCookie(request);
        if (!user) {
          auditLog({ event: "auth_failed", route: "materials", method: "GET", status: 401 });
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const db = await getDb();
        const userAddress = user.walletAddress || user.address || user.id;
        const items = await db
          .collection("materials")
          .find({ userAddress })
          .sort({ createdAt: -1 })
          .toArray();

        const normalized = items.map(sanitizeMaterial);
        return NextResponse.json(normalized);
      } catch (err) {
        if (err.name === "ValidationError") throw err;
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
        const user = await getUserFromCookie(request);
        if (!user) {
          auditLog({ event: "auth_failed", route: "materials", method: "PUT", status: 401 });
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const url = new URL(request.url);
        const materialId = url.searchParams.get("id");
        if (!materialId || !ObjectId.isValid(materialId)) {
          return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
        }

        const body = await request.json();
        const updates = validateMaterialUpdatePayload(body);
        const changeReason = validateChangeReason(body.changeReason);

        const db = await getDb();
        const userAddress = user.walletAddress || user.address || user.id;

        const existing = await db.collection("materials").findOne({ _id: new ObjectId(materialId) });
        if (!existing) {
          return NextResponse.json({ error: "Material not found" }, { status: 404 });
        }

        if (existing.userAddress !== userAddress) {
          auditLog({ event: "material_update_forbidden", route: "materials", method: "PUT", status: 403, actor: user.sub });
          return NextResponse.json({ error: "Forbidden: not the material owner" }, { status: 403 });
        }

        const now = new Date();
        const nextVersion = (existing.version || 1) + 1;
        const updateDoc = { ...updates, updatedAt: now, updatedBy: userAddress, version: nextVersion };

        const result = await db.collection("materials").findOneAndUpdate(
          { _id: new ObjectId(materialId) },
          { $set: updateDoc },
          { returnDocument: "after" }
        );

        const historyEntry = buildMaterialHistoryEntry({
          materialId,
          previousDoc: existing,
          update: updates,
          updatedBy: userAddress,
          changeReason,
          source: "creator",
        });

        await db.collection("material_history").insertOne(historyEntry);

        auditLog({ event: "material_updated", route: "materials", method: "PUT", status: 200, actor: user.sub, materialId });
        return NextResponse.json(sanitizeMaterial(result));
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

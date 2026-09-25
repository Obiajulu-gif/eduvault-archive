export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { auditLog } from "@/lib/api/audit";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";

const NOTES_COLLECTION = "learner_notes";
const MAX_NOTE_LENGTH = 5000;

function makeFilter(materialId, walletAddress) {
  return { materialId, walletAddress: walletAddress.toLowerCase() };
}

// GET /api/materials/[id]/notes — fetch the current user's note for this resource
export async function GET(request, { params }) {
  return withApiHardening(
    request,
    { route: "materials.notes", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const materialId = params?.id;
      if (!materialId || !ObjectId.isValid(materialId)) {
        return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
      }

      const user = await getUserFromCookie(request);
      if (!user) {
        auditLog({ event: "auth_failed", route: "materials.notes", method: "GET", status: 401 });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const walletAddress = (user.walletAddress || user.address || user.id || "").toLowerCase();
      if (!walletAddress) {
        return NextResponse.json({ error: "No wallet address found" }, { status: 400 });
      }

      try {
        const db = await getDb();
        const doc = await db.collection(NOTES_COLLECTION).findOne(makeFilter(materialId, walletAddress));

        return NextResponse.json({
          note: doc?.note ?? "",
          updatedAt: doc?.updatedAt ?? null,
        });
      } catch (err) {
        auditLog({ event: "notes_fetch_failed", route: "materials.notes", method: "GET", status: 500, reason: err.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

// PUT /api/materials/[id]/notes — upsert the current user's note for this resource
export async function PUT(request, { params }) {
  return withApiHardening(
    request,
    { route: "materials.notes", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      const materialId = params?.id;
      if (!materialId || !ObjectId.isValid(materialId)) {
        return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
      }

      const user = await getUserFromCookie(request);
      if (!user) {
        auditLog({ event: "auth_failed", route: "materials.notes", method: "PUT", status: 401 });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const walletAddress = (user.walletAddress || user.address || user.id || "").toLowerCase();
      if (!walletAddress) {
        return NextResponse.json({ error: "No wallet address found" }, { status: 400 });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const note = typeof body?.note === "string" ? body.note.slice(0, MAX_NOTE_LENGTH) : "";

      try {
        const db = await getDb();
        const now = new Date();
        const filter = makeFilter(materialId, walletAddress);

        await db.collection(NOTES_COLLECTION).updateOne(
          filter,
          { $set: { note, updatedAt: now }, $setOnInsert: { createdAt: now } },
          { upsert: true }
        );

        auditLog({ event: "notes_saved", route: "materials.notes", method: "PUT", status: 200, actor: user.sub });
        return NextResponse.json({ note, updatedAt: now.toISOString() });
      } catch (err) {
        auditLog({ event: "notes_save_failed", route: "materials.notes", method: "PUT", status: 500, reason: err.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";

// GET /api/materials/history?id=<materialId>
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "material-history", rateLimit: { limit: 80, windowMs: 60_000 } },
    async () => {
      try {
        const url = new URL(request.url);
        const id = url.searchParams.get("id");
        if (!id || !ObjectId.isValid(id)) {
          return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
        }

        const db = await getDb();

        const material = await db.collection("materials").findOne({ _id: new ObjectId(id) });
        if (!material) {
          return NextResponse.json({ error: "Material not found" }, { status: 404 });
        }

        const history = await db
          .collection("material_history")
          .find({ materialId: id })
          .sort({ updatedAt: -1 })
          .toArray();

        return NextResponse.json(history);
      } catch (err) {
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

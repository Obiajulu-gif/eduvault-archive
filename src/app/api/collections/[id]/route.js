import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";

export async function GET(request, { params }) {
  return withApiHardening(
    request,
    { route: "collection_detail", rateLimit: { limit: 80, windowMs: 60_000 } },
    async () => {
      try {
        const db = await getDb();
        const collectionId = (await params).id;

        let query = {};
        try {
          query._id = new ObjectId(collectionId);
        } catch (e) {
          return NextResponse.json({ error: "Invalid collection ID" }, { status: 400 });
        }

        const collection = await db.collection("collections").findOne(query);

        if (!collection) {
          return NextResponse.json({ error: "Collection not found" }, { status: 404 });
        }

        // Fetch materials in this collection
        let materials = [];
        if (collection.materialIds && collection.materialIds.length > 0) {
          const materialObjectIds = collection.materialIds.map(id => {
            try { return new ObjectId(id); } catch { return id; }
          });
          materials = await db.collection("materials").find({ _id: { $in: materialObjectIds } }).toArray();
        }

        return NextResponse.json({ ...collection, materials });
      } catch (err) {
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

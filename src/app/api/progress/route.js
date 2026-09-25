import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import jwt from "jsonwebtoken";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";

async function getUserFromCookie(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookieMatch = cookieHeader.match(/auth_token=([^;]+)/);
  const token = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload;
  } catch {
    return null;
  }
}

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "progress", rateLimit: { limit: 40, windowMs: 60_000 } },
    async () => {
      try {
        const user = await getUserFromCookie(request);
        if (!user) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const payload = await request.json();
        if (!payload.materialId) {
          return NextResponse.json({ error: "materialId is required" }, { status: 400 });
        }

        const db = await getDb();
        
        const doc = {
          userId: user.sub,
          materialId: payload.materialId,
          completedAt: new Date(),
        };

        // Upsert completion record
        await db.collection("progress").updateOne(
          { userId: user.sub, materialId: payload.materialId },
          { $set: doc },
          { upsert: true }
        );

        return NextResponse.json({ success: true, ...doc }, { status: 200 });
      } catch (err) {
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "progress", rateLimit: { limit: 80, windowMs: 60_000 } },
    async () => {
      try {
        const user = await getUserFromCookie(request);
        if (!user) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const db = await getDb();
        const items = await db
          .collection("progress")
          .find({ userId: user.sub })
          .sort({ completedAt: -1 })
          .toArray();

        // Optionally, we could join this with materials, but for now we'll just fetch materials too
        const materialObjectIds = items.map(item => {
          try { return new ObjectId(item.materialId); } catch { return item.materialId; }
        });

        const materials = await db.collection("materials").find({ _id: { $in: materialObjectIds } }).toArray();

        // Merge material details into progress items
        const results = items.map(item => {
          const material = materials.find(m => m._id.toString() === item.materialId);
          return {
            ...item,
            material: material || null
          };
        });

        return NextResponse.json(results);
      } catch (err) {
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

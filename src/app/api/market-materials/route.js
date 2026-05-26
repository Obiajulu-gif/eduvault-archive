export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { parsePagination } from "@/lib/api/validation";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";

function sanitizeMaterial(doc) {
  if (!doc) return doc;
  const { storageKey, fileUrl, metadataUrl, ...safe } = doc;
  return {
    ...safe,
    userAddress: safe.userAddress ?? safe.ownerAddress ?? null,
  };
}

// GET /api/market-materials
// Returns all public materials across users, newest first
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "market-materials", rateLimit: { limit: 120, windowMs: 60_000 } },
    async () => {
  try {
    const db = await getDb();

    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    // 1️⃣ Handle single material fetch
    if (id) {
      if (!ObjectId.isValid(id)) {
        return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
      }
      
      const item = await db.collection("materials").findOne({ 
        _id: new ObjectId(id), 
        visibility: "public" 
      });

      if (!item) {
        return NextResponse.json({ error: "Material not found" }, { status: 404 });
      }

      return NextResponse.json(sanitizeMaterial(item));
    }

    // 2️⃣ Handle list fetch
    const { page, pageSize } = parsePagination(url.searchParams);

    // Filters
    const query = { visibility: "public" };
    const search = url.searchParams.get("search");
    const subject = url.searchParams.get("subject");
    const minPrice = url.searchParams.get("minPrice");
    const maxPrice = url.searchParams.get("maxPrice");
    const creator = url.searchParams.get("creator");
    const usageRights = url.searchParams.get("usageRights");

    if (search) {
      const regex = new RegExp(search, "i");
      query.$or = [
        { title: regex },
        { description: regex },
        { author: regex },
        { subject: regex },
      ];
    }
    if (subject) query.subject = subject;
    if (minPrice) query.price = { ...query.price, $gte: Number(minPrice) };
    if (maxPrice) query.price = { ...query.price, $lte: Number(maxPrice) };
    if (creator) query["author"] = creator;
    if (usageRights) query["usageRights"] = usageRights;

    // Sorting
    let sort = { createdAt: -1 };
    const sortBy = url.searchParams.get("sortBy");
    if (sortBy === "price_asc") sort = { price: 1 };
    else if (sortBy === "price_desc") sort = { price: -1 };
    else if (sortBy === "popular") sort = { likes: -1 };
    // Default: newest

    const total = await db.collection("materials").countDocuments(query);
    const items = await db
      .collection("materials")
      .find(query)
      .sort(sort)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();

    const normalized = items.map(sanitizeMaterial);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return NextResponse.json(
      { items: normalized, page, pageSize, total, totalPages },
      { status: 200 }
    );
  } catch (err) {
    if (err.name === "ValidationError") throw err;
    auditLog({ event: "market_materials_failed", route: "market-materials", method: "GET", status: 500, reason: err.message });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
    }
  );
}

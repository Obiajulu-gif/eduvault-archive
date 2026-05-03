export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { validateMaterialPayload } from "@/lib/api/validation";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { verifyDashboardToken } from "@/lib/auth/session";

export const runtime = "nodejs";

async function getUserFromCookie(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookieMatch = cookieHeader.match(/auth_token=([^;]+)/);
  const token = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
  if (!token) return null;
  const verification = await verifyDashboardToken(token, process.env.JWT_SECRET);
  if (!verification.valid) {
    return null;
  }
  return verification.payload;
}

/**
 * Removes sensitive fields from material documents before public/client exposure.
 */
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

    // Resolve uploader wallet address reliably
    let userAddress = user.walletAddress || user.address || null;
    if (!userAddress && user.sub) {
      try {
        const dbUser = await db.collection("users").findOne({ _id: new ObjectId(user.sub) });
        userAddress = dbUser?.walletAddress || dbUser?.walletAddressLower || null;
      } catch (e) {
        // best-effort; keep null if lookup fails
        console.warn("User lookup failed while creating material:", e?.message || e);
      }
    }

    const doc = {
      userAddress,
      ...material,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("materials").insertOne(doc);
    auditLog({ event: "material_created", route: "materials", method: "POST", status: 201, actor: user.sub });
    return NextResponse.json({ id: result.insertedId, ...sanitizeMaterial(doc) }, { status: 201 });
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

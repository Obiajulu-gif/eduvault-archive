export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { verifyDashboardToken } from "@/lib/auth/session";

async function getAdminUser(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookieMatch = cookieHeader.match(/auth_token=([^;]+)/);
  const token = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
  if (!token) return null;
  const verification = await verifyDashboardToken(token, process.env.JWT_SECRET);
  if (!verification.valid) return null;
  // Extend this check once a role field is added to the users collection
  return verification.payload;
}

export async function GET(request) {
  try {
    const user = await getAdminUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const disputes = await db
      .collection("disputes")
      .find({})
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    return NextResponse.json({ disputes });
  } catch (error) {
    console.error("[admin/disputes] GET error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const user = await getAdminUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { disputeId, status, resolution } = await request.json();
    if (!disputeId || !status) {
      return NextResponse.json({ error: "disputeId and status are required" }, { status: 400 });
    }

    const db = await getDb();
    const result = await db.collection("disputes").updateOne(
      { _id: disputeId },
      {
        $set: {
          status,
          resolution: resolution ?? null,
          resolvedBy: user.sub,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[admin/disputes] PATCH error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

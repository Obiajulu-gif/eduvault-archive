import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { requirePermission, sanitizeString } from "@/lib/api/auth";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const authorization = await requirePermission(request, "creator:manage");
    if (!authorization.ok) {
      return NextResponse.json({ error: "Forbidden" }, { status: authorization.status });
    }
    const user = authorization.user;
    const body = await request.json();

    const coverPhoto = body.coverPhoto || body.coverUrl || body.coverImage;
    if (!coverPhoto || typeof coverPhoto !== "string") {
      return NextResponse.json({ error: "Invalid or missing cover photo payload" }, { status: 400 });
    }

    const sanitizedCover = sanitizeString(coverPhoto, { maxLength: 500000 });

    const db = await getDb();
    const users = db.collection("users");

    const query = user?._id
      ? { _id: user._id }
      : { walletAddress: user?.walletAddress };

    const updateRes = await users.updateOne(
      query,
      { $set: { coverPhoto: sanitizedCover, coverUrl: sanitizedCover, updatedAt: new Date().toISOString() } }
    );

    return NextResponse.json({ success: true, coverPhoto: sanitizedCover, matched: updateRes.matchedCount });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to update creator profile cover" }, { status: 500 });
  }
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const address = searchParams.get("address");

    if (!address) {
      return NextResponse.json({ error: "Missing address" }, { status: 400 });
    }

    const db = await getDb();
    const users = db.collection("users");
    const profile = await users.findOne({
      $or: [
        { walletAddress: address },
        { walletAddressLower: address.toLowerCase() },
      ],
    });

    return NextResponse.json({
      success: true,
      coverPhoto: profile?.coverPhoto || profile?.coverUrl || null,
      profile: profile || null,
    });
  } catch (error) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

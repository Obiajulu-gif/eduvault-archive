export const dynamic = "force-dynamic";

import { getDb } from "@/lib/mongodb";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { verifyDashboardToken } from "@/lib/auth/session";

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

export async function GET(req, { params }) {
  try {
    const { id } = await params;
    if (!ObjectId.isValid(id)) {
      return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
    }

    const user = await getUserFromCookie(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userAddress = user.walletAddress || user.address || user.id;
    const db = await getDb();

    // 1. Find material
    const material = await db
      .collection("materials")
      .findOne({ _id: new ObjectId(id) });
    
    if (!material) {
      return NextResponse.json({ error: "Material not found" }, { status: 404 });
    }

    // 2. Gate access
    // Check if user is the owner
    const isOwner = material.userAddress === userAddress || material.ownerAddress === userAddress;
    
    let hasAccess = isOwner;

    // If not owner, check for purchase or if it's free & public
    if (!hasAccess) {
      if (material.price > 0) {
        const entitlement = await db.collection("purchases").findOne({
          buyerAddress: userAddress,
          materialId: id,
          status: "confirmed",
        });
        if (entitlement) {
          hasAccess = true;
        }
      } else if (material.visibility === "public") {
        // Free and public materials are accessible to all registered users
        hasAccess = true;
      }
    }

    if (!hasAccess) {
      return NextResponse.json(
        {
          error: "Access denied. You do not have permission to access this material.",
        },
        { status: 403 }
      );
    }

    // 3. Yield Protected Resource
    // Use storageKey (CID) or fallback to fileUrl (if it's a legacy record)
    const storageKey = material.storageKey || material.fileUrl;
    
    if (!storageKey) {
      return NextResponse.json({ error: "Material file reference missing" }, { status: 404 });
    }

    // If it's a full URL already (legacy), return it, otherwise construct gateway URL
    const downloadUrl = storageKey.startsWith("http") 
      ? storageKey 
      : `${process.env.NEXT_PUBLIC_GATEWAY_URL || 'https://gateway.pinata.cloud'}/ipfs/${storageKey}`;

    return NextResponse.json(
      {
        success: true,
        downloadUrl,
        title: material.title,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Download Gate Error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

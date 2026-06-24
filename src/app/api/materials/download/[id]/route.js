export const dynamic = "force-dynamic";

import { getDb } from "@/lib/mongodb";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getUserFromCookie } from "@/lib/api/auth";
import { getIpfsUrl } from "@/lib/config/chain";
import { isCompletedPurchaseStatus, normalizeBuyerAddress } from "@/lib/purchases/access";

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

    const userAddress = normalizeBuyerAddress(user.walletAddress || user.address || user.id);
    const db = await getDb();

    const material = await db
      .collection("materials")
      .findOne({ _id: new ObjectId(id) });

    if (!material) {
      return NextResponse.json({ error: "Material not found" }, { status: 404 });
    }

    const isOwner =
      normalizeBuyerAddress(material.userAddress) === userAddress ||
      normalizeBuyerAddress(material.ownerAddress) === userAddress;

    let hasAccess = isOwner;

    if (!hasAccess) {
      if (material.price > 0) {
        const entitlement = await db.collection("purchases").findOne({
          buyerAddress: userAddress,
          materialId: id,
        });
        if (entitlement && isCompletedPurchaseStatus(entitlement.status)) {
          hasAccess = true;
        }
      } else if (material.visibility === "public") {
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

    const storageKey = material.storageKey || material.fileUrl;

    if (!storageKey) {
      return NextResponse.json({ error: "Material file reference missing" }, { status: 404 });
    }

    const downloadUrl = getIpfsUrl(storageKey);

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

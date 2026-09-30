import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { requirePermission } from "@/lib/api/auth";

export const dynamic = "force-dynamic";

const COLLECTION = "resource_drafts";

// Restore a saved draft for the authenticated creator.
export async function GET(request) {
  try {
    const authorization = await requirePermission(request, "creator:manage");
    if (!authorization.ok) {
      return NextResponse.json({ error: "Forbidden" }, { status: authorization.status });
    }
    const user = authorization.user;

    const { searchParams } = new URL(request.url);
    const draftId = searchParams.get("draftId");
    if (!draftId) {
      return NextResponse.json({ error: "Missing draftId" }, { status: 400 });
    }

    const db = await getDb();
    const draft = await db.collection(COLLECTION).findOne({
      userRef: user._id?.toString() || user.walletAddress,
      draftId,
    });

    if (!draft) {
      return NextResponse.json({ success: true, draft: null });
    }

    return NextResponse.json({ success: true, draft: { draftId, value: draft.value, savedAt: draft.savedAt } });
  } catch (error) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

// Persist a draft for the authenticated creator.
export async function PUT(request) {
  try {
    const authorization = await requirePermission(request, "creator:manage");
    if (!authorization.ok) {
      return NextResponse.json({ error: "Forbidden" }, { status: authorization.status });
    }
    const user = authorization.user;

    const body = await request.json();
    const { draftId, value } = body;
    if (!draftId || typeof value !== "object" || value === null) {
      return NextResponse.json({ error: "Invalid draft payload" }, { status: 400 });
    }

    const db = await getDb();
    const userRef = user._id?.toString() || user.walletAddress;
    const now = new Date();

    await db.collection(COLLECTION).updateOne(
      { userRef, draftId },
      {
        $set: {
          userRef,
          draftId,
          value,
          savedAt: now,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    return NextResponse.json({ success: true, savedAt: now });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to save draft" }, { status: 500 });
  }
}

// Discard a saved draft (e.g. after a successful publish).
export async function DELETE(request) {
  try {
    const authorization = await requirePermission(request, "creator:manage");
    if (!authorization.ok) {
      return NextResponse.json({ error: "Forbidden" }, { status: authorization.status });
    }
    const user = authorization.user;

    const { searchParams } = new URL(request.url);
    const draftId = searchParams.get("draftId");
    if (!draftId) {
      return NextResponse.json({ error: "Missing draftId" }, { status: 400 });
    }

    const db = await getDb();
    const userRef = user._id?.toString() || user.walletAddress;
    await db.collection(COLLECTION).deleteOne({ userRef, draftId });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

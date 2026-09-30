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
//
// Concurrency strategy:
// - The default Mongo upsert is not atomic across concurrent writes and can raise E11000 duplicate-key errors or create duplicate documents if a unique index is missing.
// - We enforce a unique compound index on (userRef, draftId) and retry on duplicate-key errors so the last writer wins with a single canonical record.
// - The write is idempotent: repeated PUTs with the same payload produce the same document state.
const MAX_UPSERT_RETRIES = 5;

async function ensureDraftIndex(db) {
  try {
    await db.collection(COLLECTION).createIndex(
      { userRef: 1, draftId: 1 },
      { unique: true, name: "userRef_draftId_unique" }
    );
  } catch (error) {
    // Index already exists with the same spec, or a conflicting index exists.
    // Either way the invariant is enforced by the DB or the retry loop.
    if (error?.code !== 85 && error?.codeName !== "IndexOptionsConflict") {
      throw error;
    }
  }
}

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
    await ensureDraftIndex(db);

    const userRef = user._id?.toString() || user.walletAddress;
    const now = new Date();

    let lastError = null;
    for (let attempt = 0; attempt < MAX_UPSERT_RETRIES; attempt++) {
      try {
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
        // E11000: another concurrent upsert won the race. Retry as an
        // update against the now-existing document so the last writer wins.
        if (error?.code === 11000) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error("Failed to save draft after retries");
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
    // deleteOne is idempotent: concurrent deletes of the same draft all
    // resolve to a single canonical result with no duplicate side-effects.
    await db.collection(COLLECTION).deleteOne({ userRef, draftId });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

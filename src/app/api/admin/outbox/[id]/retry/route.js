import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import { retryFailedOutboxEntry } from "@/lib/backend/outbox";
import { ObjectId } from "mongodb";

export async function POST(request, { params }) {
  try {
    const admin = await requireAdmin(request);
    if (!admin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    
    // Some Next.js versions require awaiting params if they are async.
    const resolvedParams = await Promise.resolve(params);
    const idParam = resolvedParams.id;
    let entryId;
    try {
      entryId = new ObjectId(idParam);
    } catch (e) {
      return NextResponse.json({ error: "Invalid ID format" }, { status: 400 });
    }

    const result = await retryFailedOutboxEntry(db, entryId, admin.sub);

    if (result.outcome === "not_found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (result.outcome === "not_failed") {
      return NextResponse.json({ error: "Entry is not in dead_letter state", intent: result.intent }, { status: 400 });
    }
    if (result.outcome === "conflict") {
      return NextResponse.json({ error: "Conflict updating entry" }, { status: 409 });
    }

    return NextResponse.json({ success: true, intent: result.intent });
  } catch (error) {
    console.error("Failed to retry outbox entry:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

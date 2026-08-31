import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import { getOutboxHealth } from "@/lib/backend/outbox";

export async function GET(request) {
  try {
    const admin = await requireAdmin(request);
    if (!admin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const health = await getOutboxHealth(db);

    return NextResponse.json({ health });
  } catch (error) {
    console.error("Failed to get outbox health:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

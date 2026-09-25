import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { getUserFromCookie } from "@/lib/api/auth";
import { buildAnalyticsEvent, enqueueAnalyticsEvent } from "@/lib/backend/analyticsEvents";

export const runtime = "nodejs";

function clientIp(request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export async function POST(request, { params }) {
  const body = await request.json().catch(() => ({}));
  const eventType = body.eventType || "view";
  if (!["view", "download"].includes(eventType)) {
    return NextResponse.json({ error: "Invalid event type" }, { status: 400 });
  }

  const user = await getUserFromCookie(request);
  const viewerId = user?.walletAddress || user?.address || user?.sub || request.cookies.get("ev_analytics_session")?.value;
  const db = await getDb();
  const material = await db.collection("materials").findOne({ $or: [{ materialId: params.id }, ...(ObjectId.isValid(params.id) ? [{ _id: new ObjectId(params.id) }] : [])] });
  const event = buildAnalyticsEvent({
    materialId: params.id,
    eventType,
    viewerId,
    ipAddress: clientIp(request),
    userAgent: request.headers.get("user-agent") || "",
    headers: { accept: request.headers.get("accept") || "" },
    dwellMs: body.dwellMs,
    interactionCount: body.interactionCount,
    excludedReason: material && viewerId && [material.userAddress, material.creatorAddress, material.creatorId].filter(Boolean).map(String).includes(String(viewerId)) ? "creator_view" : null,
  });
  await enqueueAnalyticsEvent({ db, event });
  return NextResponse.json({ accepted: true, dedupeWindowMs: 30 * 60 * 1000 }, { status: 202 });
}
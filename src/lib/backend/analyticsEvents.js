import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { enqueueSideEffect } from "./outbox.js";

export const ANALYTICS_RAW_COLLECTION = "material_analytics_events";
export const ANALYTICS_WINDOW_MS = 30 * 60 * 1000;

const BOT_USER_AGENT = /bot|crawler|spider|scrape|curl|wget|headless|phantom|selenium|playwright/i;

function hash(value) {
  return crypto
    .createHmac("sha256", process.env.ANALYTICS_HASH_SECRET || "eduvault-analytics")
    .update(String(value || "unknown"))
    .digest("hex");
}

export function classifyAnalyticsTraffic({ userAgent = "", headers = {}, dwellMs = 0, interactionCount = 0 } = {}) {
  const reasons = [];
  if (BOT_USER_AGENT.test(userAgent)) reasons.push("known_bot_user_agent");
  if (headers.accept && !headers.accept.includes("text/html") && !headers.accept.includes("*/*")) reasons.push("non_browser_accept");
  if (Number(dwellMs) < 750 && Number(interactionCount) === 0) reasons.push("no_engagement_signal");
  return { isBot: reasons.length > 0, reasons };
}

export function buildAnalyticsEvent({ materialId, eventType, viewerId, ipAddress, userAgent, headers, dwellMs, interactionCount, excludedReason = null, now = new Date() }) {
  if (!materialId || !["view", "download"].includes(eventType)) throw new Error("Invalid analytics event");
  const bucket = Math.floor(now.getTime() / ANALYTICS_WINDOW_MS);
  const viewerKey = hash(viewerId || `${ipAddress || "unknown"}:${userAgent || "unknown"}`);
  const traffic = classifyAnalyticsTraffic({ userAgent, headers, dwellMs, interactionCount });
  return {
    eventKey: `${eventType}:${materialId}:${viewerKey}:${bucket}`,
    materialId: String(materialId),
    eventType,
    viewerHash: viewerKey,
    isBot: traffic.isBot,
    excludedReason,
    botReasons: traffic.reasons,
    dwellMs: Math.max(0, Number(dwellMs) || 0),
    interactionCount: Math.max(0, Number(interactionCount) || 0),
    occurredAt: now,
  };
}

export async function enqueueAnalyticsEvent({ db, event }) {
  return enqueueSideEffect({
    db,
    sourceAggregate: "material_analytics",
    sourceId: event.materialId,
    deliveryId: `analytics:${event.eventKey}`,
    intent: { type: "analytics", action: "material_event", payload: event },
  });
}

export async function applyAnalyticsEvent(db, event, { now = new Date() } = {}) {
  const raw = db.collection(ANALYTICS_RAW_COLLECTION);
  try {
    await raw.insertOne({ _id: event.eventKey, ...event, recordedAt: now });
  } catch (error) {
    if (error?.code === 11000) return { action: "duplicate", eventKey: event.eventKey };
    throw error;
  }

  const field = event.eventType === "download" ? "trustedDownloadCount" : "trustedViewCount";
  const botField = event.eventType === "download" ? "filteredDownloadCount" : "filteredViewCount";
  const materialId = ObjectId.isValid(event.materialId) ? new ObjectId(event.materialId) : event.materialId;
  await db.collection("materials").updateOne(
    { $or: [{ _id: materialId }, { materialId: event.materialId }] },
    { $inc: { [event.isBot || event.excludedReason ? botField : field]: 1 }, $set: { analyticsUpdatedAt: now } },
  );
  return { action: event.isBot || event.excludedReason ? "filtered" : "counted", eventKey: event.eventKey };
}
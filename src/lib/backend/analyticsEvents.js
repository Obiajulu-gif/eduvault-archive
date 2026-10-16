import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { enqueueSideEffect } from "./outbox.js";

/**
 * Privacy-preserving analytics storage.
 *
 * `material_analytics_aggregates` contains only daily counters. The separate
 * dedupe collection contains an opaque HMAC key for one short window and has
 * a TTL index; it never contains a wallet, IP address, user agent, request
 * headers, content, search query, or event payload.
 */
export const ANALYTICS_AGGREGATE_COLLECTION = "material_analytics_aggregates";
export const ANALYTICS_DEDUPE_COLLECTION = "material_analytics_dedupe";
export const ANALYTICS_WINDOW_MS = 30 * 60 * 1000;
export const ANALYTICS_DEDUPE_RETENTION_SECONDS = 60 * 60;

const BOT_USER_AGENT = /bot|crawler|spider|scrape|curl|wget|headless|phantom|selenium|playwright/i;

function hmac(value) {
  return crypto
    .createHmac("sha256", process.env.ANALYTICS_HASH_SECRET || "eduvault-analytics")
    .update(String(value || "unknown"))
    .digest("hex");
}

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

export function classifyAnalyticsTraffic({ userAgent = "", headers = {}, dwellMs = 0, interactionCount = 0 } = {}) {
  const reasons = [];
  if (BOT_USER_AGENT.test(userAgent)) reasons.push("known_bot_user_agent");
  if (headers.accept && !headers.accept.includes("text/html") && !headers.accept.includes("*/*")) reasons.push("non_browser_accept");
  if (Number(dwellMs) < 750 && Number(interactionCount) === 0) reasons.push("no_engagement_signal");
  return { isBot: reasons.length > 0, reasons };
}

/**
 * Build the minimal event used by the aggregate worker. Identifying request
 * values are used only to derive an opaque, short-lived dedupe key and are
 * intentionally absent from the returned object.
 */
export function buildAnalyticsEvent({
  materialId, eventType, viewerId, ipAddress, userAgent, headers,
  dwellMs, interactionCount, excludedReason = null, source = "client-reported",
  now = new Date(),
}) {
  if (!materialId || !["view", "download", "purchase"].includes(eventType)) {
    throw new Error(`Invalid analytics event: type="${eventType}" materialId="${materialId}"`);
  }
  const bucket = Math.floor(now.getTime() / ANALYTICS_WINDOW_MS);
  const identity = viewerId || `${ipAddress || "unknown"}:${userAgent || "unknown"}`;
  const traffic = classifyAnalyticsTraffic({ userAgent, headers, dwellMs, interactionCount });
  const filtered = traffic.isBot || Boolean(excludedReason);

  return {
    // This is a one-way key, retained only in ANALYTICS_DEDUPE_COLLECTION for
    // the dedupe window. It is never returned from an analytics API/export.
    dedupeKey: hmac(`${eventType}:${materialId}:${identity}:${bucket}`),
    materialId: String(materialId),
    eventType,
    source: source === "server-confirmed" ? "server-confirmed" : "client-reported",
    classification: filtered ? "filtered" : "trusted",
    filterReason: excludedReason ? "creator_activity" : traffic.isBot ? "automated_or_unengaged" : null,
    day: utcDay(now),
  };
}

export async function enqueueAnalyticsEvent({ db, event }) {
  return enqueueSideEffect({
    db,
    sourceAggregate: "material_analytics",
    sourceId: event.materialId,
    deliveryId: `analytics:${event.dedupeKey}`,
    intent: { type: "analytics", action: "material_event", payload: event },
  });
}

export async function recordServerAnalyticsEvent(db, event, { now = new Date() } = {}) {
  return applyAnalyticsEvent(db, event, { now });
}

/** Atomically reserve a short-lived dedupe key, then increment one safe daily bucket. */
export async function applyAnalyticsEvent(db, event, { now = new Date() } = {}) {
  const dedupe = db.collection(ANALYTICS_DEDUPE_COLLECTION);
  try {
    await dedupe.insertOne({
      _id: event.dedupeKey,
      expiresAt: new Date(now.getTime() + ANALYTICS_DEDUPE_RETENTION_SECONDS * 1000),
    });
  } catch (error) {
    if (error?.code === 11000) return { action: "duplicate" };
    throw error;
  }

  const materialId = ObjectId.isValid(event.materialId) ? new ObjectId(event.materialId) : event.materialId;
  const fields = event.eventType === "download"
    ? { trusted: "trustedDownloadCount", filtered: "filteredDownloadCount" }
    : event.eventType === "purchase"
      ? { trusted: "confirmedPurchaseCount", filtered: "filteredPurchaseCount" }
      : { trusted: "trustedViewCount", filtered: "filteredViewCount" };
  const countField = event.classification === "trusted" ? fields.trusted : fields.filtered;

  await Promise.all([
    db.collection(ANALYTICS_AGGREGATE_COLLECTION).updateOne(
      { materialId: event.materialId, day: event.day, eventType: event.eventType, source: event.source, classification: event.classification, filterReason: event.filterReason },
      { $inc: { count: 1 }, $set: { updatedAt: now }, $setOnInsert: { materialId: event.materialId, day: event.day, eventType: event.eventType, source: event.source, classification: event.classification, filterReason: event.filterReason, createdAt: now } },
      { upsert: true },
    ),
    db.collection("materials").updateOne(
      { $or: [{ _id: materialId }, { materialId: event.materialId }] },
      { $inc: { [countField]: 1, ...(event.source === "server-confirmed" ? { [`serverConfirmed_${event.eventType}Count`]: 1 } : {}) }, $set: { analyticsUpdatedAt: now } },
    ),
  ]);
  return { action: event.classification === "trusted" ? "counted" : "filtered" };
}

/** Return safe aggregate counts only; no user-level event records are queried or exported. */
export async function getAnalyticsGapStats(db, materialIds, { from, to } = {}) {
  const match = {
    materialId: { $in: materialIds.map(String) },
    ...(from || to ? { day: { ...(from ? { $gte: utcDay(from) } : {}), ...(to ? { $lte: utcDay(to) } : {}) } } : {}),
  };
  const rows = await db.collection(ANALYTICS_AGGREGATE_COLLECTION).aggregate([
    { $match: { ...match, classification: "trusted" } },
    { $group: { _id: { eventType: "$eventType", source: "$source" }, count: { $sum: "$count" } } },
  ]).toArray();
  const breakdown = {};
  for (const row of rows) {
    const { eventType, source } = row._id;
    breakdown[eventType] ||= { serverConfirmed: 0, clientReported: 0 };
    breakdown[eventType][source === "server-confirmed" ? "serverConfirmed" : "clientReported"] = row.count;
  }
  const serverConfirmed = Object.values(breakdown).reduce((n, row) => n + row.serverConfirmed, 0);
  const clientReported = Object.values(breakdown).reduce((n, row) => n + row.clientReported, 0);
  const total = serverConfirmed + clientReported;
  return {
    serverConfirmed, clientReported, total,
    adBlockerEstimatedLossRate: total > 0 ? (total - serverConfirmed) / total : null,
    breakdown,
    methodology: {
      storage: "Daily aggregate counters by material, event type, source, and traffic classification.",
      dedupeWindowMs: ANALYTICS_WINDOW_MS,
      note: "No wallet addresses, IP addresses, user agents, request headers, content, search terms, or event payloads are included.",
    },
  };
}

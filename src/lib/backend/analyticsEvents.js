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

/**
 * Build a structured analytics event.
 *
 * @param {object} params
 * @param {"view"|"download"|"purchase"} params.eventType
 * @param {"server-confirmed"|"client-reported"} [params.source]
 *   Distinguishes authoritative server-side events (purchase completion,
 *   download issuance — immune to ad blockers) from client-side beacon events
 *   (subject to ad-blocker / page-unload loss). Dashboards MUST surface this
 *   label so creators understand which counts are reliable.
 */
export function buildAnalyticsEvent({
  materialId,
  eventType,
  viewerId,
  ipAddress,
  userAgent,
  headers,
  dwellMs,
  interactionCount,
  excludedReason = null,
  source = "client-reported",
  now = new Date(),
}) {
  if (!materialId || !["view", "download", "purchase"].includes(eventType)) {
    throw new Error(`Invalid analytics event: type="${eventType}" materialId="${materialId}"`);
  }
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
    source,
    occurredAt: now,
  };
}

/**
 * Enqueue an analytics event through the outbox side-effect pipeline.
 * The worker will call `applyAnalyticsEvent` later.
 */
export async function enqueueAnalyticsEvent({ db, event }) {
  return enqueueSideEffect({
    db,
    sourceAggregate: "material_analytics",
    sourceId: event.materialId,
    deliveryId: `analytics:${event.eventKey}`,
    intent: { type: "analytics", action: "material_event", payload: event },
  });
}

/**
 * Directly record a server-confirmed analytics event without the outbox queue.
 *
 * Use this in authoritative API routes (purchase, download) where the event
 * MUST be recorded because the server already validated the action. These
 * events are completely immune to ad blockers and page-unload cancellations.
 *
 * @param {object} db
 * @param {object} event - Built with buildAnalyticsEvent({ source: "server-confirmed" })
 * @param {{ now?: Date }} [options]
 */
export async function recordServerAnalyticsEvent(db, event, { now = new Date() } = {}) {
  return applyAnalyticsEvent(db, event, { now });
}

/**
 * Apply an analytics event to the raw collection and update material counters.
 * Called by the side-effect worker for enqueued events, and directly by
 * `recordServerAnalyticsEvent` for server-confirmed events.
 */
export async function applyAnalyticsEvent(db, event, { now = new Date() } = {}) {
  const raw = db.collection(ANALYTICS_RAW_COLLECTION);
  try {
    await raw.insertOne({ _id: event.eventKey, ...event, recordedAt: now });
  } catch (error) {
    if (error?.code === 11000) return { action: "duplicate", eventKey: event.eventKey };
    throw error;
  }

  // Field mapping: each event type has a trusted counter and a filtered counter.
  const FIELD_MAP = {
    download: { trusted: "trustedDownloadCount",   filtered: "filteredDownloadCount"  },
    purchase: { trusted: "confirmedPurchaseCount",  filtered: "filteredPurchaseCount"  },
    view:     { trusted: "trustedViewCount",         filtered: "filteredViewCount"      },
  };
  const fields = FIELD_MAP[event.eventType] ?? FIELD_MAP.view;
  const countField = event.isBot || event.excludedReason ? fields.filtered : fields.trusted;

  // Separate server-confirmed sub-counter for gap analysis (never conflated with
  // client-reported counts so dashboard can show both with appropriate caveats).
  const serverInc = event.source === "server-confirmed"
    ? { [`serverConfirmed_${event.eventType}Count`]: 1 }
    : {};

  const materialId = ObjectId.isValid(event.materialId)
    ? new ObjectId(event.materialId)
    : event.materialId;

  await db.collection("materials").updateOne(
    { $or: [{ _id: materialId }, { materialId: event.materialId }] },
    { $inc: { [countField]: 1, ...serverInc }, $set: { analyticsUpdatedAt: now } },
  );
  return { action: event.isBot || event.excludedReason ? "filtered" : "counted", eventKey: event.eventKey };
}

/**
 * Compute discrepancy statistics between server-confirmed and client-reported
 * events. Used by the /api/analytics/gap endpoint to surface the ad-blocker
 * impact to creators in a transparent, quantified form.
 *
 * Download events are the best proxy for ad-blocker impact because both the
 * server (capability issuance) and client (beacon) record the same action.
 *
 * @param {object} db
 * @param {string[]} materialIds
 * @param {{ from?: Date, to?: Date }} [dateRange]
 */
export async function getAnalyticsGapStats(db, materialIds, { from, to } = {}) {
  const timeFilter = from || to
    ? { occurredAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } }
    : {};
  const match = { materialId: { $in: materialIds.map(String) }, ...timeFilter };

  const [serverConfirmed, clientReported] = await Promise.all([
    db.collection(ANALYTICS_RAW_COLLECTION).countDocuments({ ...match, source: "server-confirmed", isBot: false }),
    db.collection(ANALYTICS_RAW_COLLECTION).countDocuments({ ...match, source: "client-reported",  isBot: false }),
  ]);

  const byType = await db
    .collection(ANALYTICS_RAW_COLLECTION)
    .aggregate([
      { $match: { ...match, isBot: false } },
      { $group: { _id: { eventType: "$eventType", source: "$source" }, count: { $sum: 1 } } },
    ])
    .toArray();

  const breakdown = {};
  for (const row of byType) {
    const { eventType, source } = row._id;
    breakdown[eventType] = breakdown[eventType] || { serverConfirmed: 0, clientReported: 0 };
    const key = source === "server-confirmed" ? "serverConfirmed" : "clientReported";
    breakdown[eventType][key] = row.count;
  }

  const total = serverConfirmed + clientReported;
  // The estimated loss rate is only meaningful for event types where BOTH paths
  // fire (e.g. download). For view-only events, clientReported is the sole source.
  const adBlockerEstimatedLossRate = total > 0 ? (total - serverConfirmed) / total : null;

  return {
    serverConfirmed,
    clientReported,
    total,
    adBlockerEstimatedLossRate,
    breakdown,
    methodology: {
      serverConfirmedDescription:
        "Events recorded server-side during an authoritative action (purchase completion, download capability issuance). Immune to ad blockers and page-unload cancellation. Ground truth.",
      clientReportedDescription:
        "Events sent from the browser via sendBeacon / fetch-keepalive. May be silently dropped by ad blockers or privacy extensions. Directional signal only.",
      dedupeWindowMs: ANALYTICS_WINDOW_MS,
      note:
        "The gap between clientReported and serverConfirmed for 'download' events is the best proxy for ad-blocker impact. View events are client-only and cannot be compared.",
    },
  };
}
import { describe, expect, it } from "vitest";
import { ANALYTICS_AGGREGATE_COLLECTION, ANALYTICS_DEDUPE_COLLECTION, applyAnalyticsEvent, buildAnalyticsEvent } from "./analyticsEvents.js";

describe("privacy-preserving material analytics", () => {
  it("keeps identifying request values out of the event and persists only safe aggregate fields", async () => {
    const dedupe = new Map();
    const aggregateUpdates = [];
    const db = { collection(name) {
      if (name === ANALYTICS_DEDUPE_COLLECTION) return { insertOne: async (doc) => { if (dedupe.has(doc._id)) { const error = new Error(); error.code = 11000; throw error; } dedupe.set(doc._id, doc); } };
      if (name === ANALYTICS_AGGREGATE_COLLECTION) return { updateOne: async (...args) => aggregateUpdates.push(args) };
      return { updateOne: async () => {} };
    } };
    const event = buildAnalyticsEvent({ materialId: "m1", eventType: "view", viewerId: "GVIEWER", ipAddress: "203.0.113.4", userAgent: "Mozilla/5.0", headers: { accept: "text/html", cookie: "secret" }, dwellMs: 1000, interactionCount: 1, now: new Date("2026-01-02T12:00:00Z") });
    for (const forbidden of ["viewerId", "viewerHash", "ipAddress", "userAgent", "headers", "dwellMs", "interactionCount", "botReasons"]) expect(event).not.toHaveProperty(forbidden);
    expect(event).toMatchObject({ materialId: "m1", eventType: "view", day: "2026-01-02", classification: "trusted" });
    expect((await applyAnalyticsEvent(db, event)).action).toBe("counted");
    expect((await applyAnalyticsEvent(db, event)).action).toBe("duplicate");
    expect(aggregateUpdates).toHaveLength(1);
    const [filter, update] = aggregateUpdates[0];
    expect(filter).toEqual({ materialId: "m1", day: "2026-01-02", eventType: "view", source: "client-reported", classification: "trusted", filterReason: null });
    expect(update.$setOnInsert).not.toHaveProperty("dedupeKey");
    expect([...dedupe.values()][0]).toEqual(expect.objectContaining({ _id: event.dedupeKey, expiresAt: expect.any(Date) }));
  });
});

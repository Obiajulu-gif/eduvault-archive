import { describe, expect, it } from "vitest";
import { applyAnalyticsEvent, buildAnalyticsEvent } from "./analyticsEvents.js";

describe("material analytics", () => {
  it("deduplicates the same viewer and material within the window", async () => {
    const stored = new Map();
    const updates = [];
    const db = {
      collection(name) {
        if (name === "material_analytics_events") return { insertOne: async (doc) => { if (stored.has(doc._id)) { const error = new Error(); error.code = 11000; throw error; } stored.set(doc._id, doc); } };
        return { updateOne: async (...args) => updates.push(args) };
      },
    };
    const event = buildAnalyticsEvent({ materialId: "m1", eventType: "view", viewerId: "viewer", userAgent: "Mozilla", headers: { accept: "text/html" }, dwellMs: 1000, interactionCount: 1 });
    expect((await applyAnalyticsEvent(db, event)).action).toBe("counted");
    expect((await applyAnalyticsEvent(db, event)).action).toBe("duplicate");
    expect(updates).toHaveLength(1);
  });
});
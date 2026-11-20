import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import {
  getDefaultNotificationPreferences,
  isNotificationEnabled,
  normalizeNotificationPreferences,
  validateNotificationPreferencesPayload,
} from "../../src/lib/api/validation.js";

process.env.EMAIL_USER = "test@example.com";
process.env.EMAIL_PASS = "test-password";
globalThis.__sentMail = [];
const nodemailerStub =
  "data:text/javascript," +
  encodeURIComponent(`
    export default {
      createTransport() {
        return {
          async sendMail(message) {
            globalThis.__sentMail.push(message);
          },
        };
      },
    };
  `);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "nodemailer") {
      return { url: nodemailerStub, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { sendInactivityReminder } = await import(
  "../../src/lib/email/inactivityReminder.js"
);

describe("notification preferences", () => {
  it("enables all optional categories by default and keeps receipts on", () => {
    assert.deepEqual(getDefaultNotificationPreferences(), {
      receipts: true,
      reviews: true,
      sales: true,
      reminders: true,
      productUpdates: true,
    });
    assert.deepEqual(normalizeNotificationPreferences({ receipts: false, reviews: false }), {
      receipts: true,
      reviews: false,
      sales: true,
      reminders: true,
      productUpdates: true,
    });
    assert.equal(
      isNotificationEnabled({ notificationPreferences: { receipts: false } }, "receipts"),
      true
    );
    assert.equal(
      isNotificationEnabled({ notificationPreferences: { reminders: false } }, "reminders"),
      false
    );
  });

  it("validates partial preference payloads", () => {
    assert.deepEqual(validateNotificationPreferencesPayload({ reviews: false }), {
      receipts: true,
      reviews: false,
      sales: true,
      reminders: true,
      productUpdates: true,
    });
    assert.throws(
      () => validateNotificationPreferencesPayload({ receipts: false }),
      /Receipts cannot be disabled/
    );
    assert.throws(
      () => validateNotificationPreferencesPayload({ unknown: true }),
      /Unknown notification category/
    );
    assert.throws(
      () => validateNotificationPreferencesPayload({ sales: "no" }),
      /Invalid value for sales/
    );
    assert.throws(
      () => validateNotificationPreferencesPayload({}),
      /No notification preferences provided/
    );
  });

  it("stops inactivity emails when reminders are disabled", async () => {
    globalThis.__sentMail = [];
    const stats = { materialCount: 2, demotedCount: 1 };

    const skipped = await sendInactivityReminder(
      "creator@example.com",
      "Creator",
      200,
      stats,
      { notificationPreferences: { reminders: false } }
    );
    assert.equal(skipped.sent, false);
    assert.equal(globalThis.__sentMail.length, 0);

    const sent = await sendInactivityReminder(
      "creator@example.com",
      "Creator",
      200,
      stats,
      { notificationPreferences: { reminders: true } }
    );
    assert.equal(sent.sent, true);
    assert.equal(globalThis.__sentMail.length, 1);
  });

  it("always allows receipt senders", () => {
    assert.equal(isNotificationEnabled({ notificationPreferences: { receipts: false } }, "receipts"), true);
    assert.equal(isNotificationEnabled(undefined, "receipts"), true);
  });
});

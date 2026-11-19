// @vitest-environment node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, beforeEach, vi } from "vitest";
vi.unmock("@/lib/webhooks/sender");
vi.unmock("../webhooks/sender.js");
import {
  clearWebhookReplayCache,
  createWebhookSignatureHeader,
  verifyWebhookSignature,
  verifyWebhookSignatureWithRotation,
} from "../webhooks/sender.js";
import {
  createCapabilityNonceStore,
  generateSensitiveCapabilityToken,
  verifySensitiveCapabilityToken,
} from "../auth/sensitiveCapabilityToken.js";
import { isSafeUrl } from "../api/safeUrl.js";
import { sanitizeFieldName } from "./sensitiveAccessLog.js";
import { hashPayload, withIdempotency } from "../backend/idempotency.js";
import { createFakeCollection, createFakeDb } from "../refunds/__tests__/fakeMongo.js";

const REPLAY_CORPUS_PATH = path.resolve(
  process.cwd(),
  "test/fixtures/malformed-replay/cases.json"
);
const WEBHOOK_CORPUS_PATH = path.resolve(
  process.cwd(),
  "test/fixtures/webhook-adversarial/cases.json"
);

const corpus = JSON.parse(readFileSync(REPLAY_CORPUS_PATH, "utf8"));
const webhookCases = JSON.parse(readFileSync(WEBHOOK_CORPUS_PATH, "utf8"));

function makeUniqueIdempotencyDb() {
  const col = createFakeCollection();
  const origInsert = col.insertOne.bind(col);
  col.insertOne = async (doc) => {
    if (doc._id !== undefined && col.docs.some((d) => d._id === doc._id)) {
      throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    }
    return origInsert(doc);
  };
  return createFakeDb({ idempotency_keys: col });
}

describe("malformed payload and replay attack fixtures (#1074)", () => {
  beforeEach(() => {
    clearWebhookReplayCache();
  });

  it("normal path: valid webhook signature, valid capability token, and safe URLs succeed", () => {
    const body = JSON.stringify({ event: "purchase.completed", id: "ok-1" });
    const header = createWebhookSignatureHeader(body, "good-secret", 1_700_000_000);
    assert.equal(verifyWebhookSignature(body, header, "good-secret", { now: 1_700_000_000 }), true);
    assert.equal(isSafeUrl("https://eduvault.example/materials/1"), true);
    assert.equal(sanitizeFieldName("user.email"), "user.email");

    const nonceStore = createCapabilityNonceStore();
    const capNow = Date.now();
    const { token } = generateSensitiveCapabilityToken({
      action: "material:archive",
      actor: "creator-1",
      target: "mat-1",
      secret: "cap-secret",
      iat: capNow,
    });
    const verified = verifySensitiveCapabilityToken(token, {
      expectedAction: "material:archive",
      expectedActor: "creator-1",
      expectedTarget: "mat-1",
      secret: "cap-secret",
      store: nonceStore,
      consume: true,
      now: capNow + 1000,
    });
    assert.equal(verified.valid, true);
  });

  it("failure path: rejects or safely neutralizes every malformed payload fixture", () => {
    const validators = { sanitizeFieldName, isSafeUrl };

    for (const fixture of corpus.malformedPayloads) {
      if (fixture.expect === "no-prototype-pollution") {
        const parsed = JSON.parse(fixture.rawJson);
        const digest = hashPayload(parsed);
        assert.match(digest, /^[0-9a-f]{64}$/);
        assert.equal(({}).isAdmin, undefined, `${fixture.id} polluted Object.prototype`);
        assert.equal(({}).role, undefined, `${fixture.id} polluted Object.prototype`);
      } else {
        const fn = validators[fixture.validator];
        assert.equal(fn(fixture.value), fixture.expect, `${fixture.id} mismatch`);
      }
    }
  });

  it("failure path: rejects every adversarial webhook fixture including new edge cases", () => {
    for (const tc of webhookCases) {
      const ok = verifyWebhookSignature(tc.body, tc.signatureHeader, tc.secret, {
        now: tc.verifyAt,
      });
      assert.equal(ok, false, `Expected webhook fixture "${tc.id}" to be rejected`);
    }
  });

  it("replay & authorization paths: rejects JTI replay, expired tokens, cross-actor replay, and idempotency mutation", async () => {
    const nonceStore = createCapabilityNonceStore();
    const baseNow = Date.now();

    for (const attack of corpus.replayAttacks) {
      if (attack.id === "capability-token-jti-replay") {
        const { token } = generateSensitiveCapabilityToken({
          action: attack.action,
          actor: attack.actorId,
          target: attack.resourceId,
          secret: "cap-secret",
          iat: baseNow,
        });
        const first = verifySensitiveCapabilityToken(token, {
          expectedAction: attack.action,
          expectedActor: attack.actorId,
          expectedTarget: attack.resourceId,
          secret: "cap-secret",
          store: nonceStore,
          consume: true,
          now: baseNow + 1000,
        });
        assert.equal(first.valid, true);

        const replay = verifySensitiveCapabilityToken(token, {
          expectedAction: attack.action,
          expectedActor: attack.actorId,
          expectedTarget: attack.resourceId,
          secret: "cap-secret",
          store: nonceStore,
          consume: true,
          now: baseNow + 2000,
        });
        assert.equal(replay.valid, false);
      } else if (attack.id === "capability-token-expired") {
        const { token } = generateSensitiveCapabilityToken({
          action: attack.action,
          actor: attack.actorId,
          target: attack.resourceId,
          ttlMs: 10_000,
          secret: "cap-secret",
          iat: baseNow,
        });
        const expired = verifySensitiveCapabilityToken(token, {
          expectedAction: attack.action,
          expectedActor: attack.actorId,
          expectedTarget: attack.resourceId,
          secret: "cap-secret",
          now: baseNow + 10_000 + attack.expiredByMs,
        });
        assert.equal(expired.valid, false);
      } else if (attack.id === "capability-token-cross-actor") {
        const { token } = generateSensitiveCapabilityToken({
          action: attack.action,
          actor: attack.issuedTo,
          target: attack.resourceId,
          secret: "cap-secret",
          iat: baseNow,
        });
        const crossActor = verifySensitiveCapabilityToken(token, {
          expectedAction: attack.action,
          expectedActor: attack.presentedBy,
          expectedTarget: attack.resourceId,
          secret: "cap-secret",
          now: baseNow + 1000,
        });
        assert.equal(crossActor.valid, false);
      } else if (attack.id === "idempotency-key-payload-mutation") {
        const db = makeUniqueIdempotencyDb();
        let runs = 0;
        const first = await withIdempotency(db, attack.key, attack.originalPayload, async () => {
          runs += 1;
          return { ok: true };
        });
        assert.equal(first.replayed, false);
        assert.equal(runs, 1);

        // Retry with identical payload succeeds as safe replay
        const legitimateRetry = await withIdempotency(db, attack.key, attack.originalPayload, async () => {
          runs += 1;
          return { ok: true };
        });
        assert.equal(legitimateRetry.replayed, true);
        assert.equal(runs, 1);

        // Replay same key with mutated payload fails closed
        await assert.rejects(
          () => withIdempotency(db, attack.key, attack.mutatedPayload, async () => ({ ok: true })),
          (err) => err.code === "CONFLICT_IDEMPOTENCY_KEY"
        );
      }
    }
  });

  it("replay across key rotation: rejects replayed signature even when previousSecret is still in grace window", () => {
    const body = JSON.stringify({ event: "payout.settled", id: "rot-replay-1" });
    const header = createWebhookSignatureHeader(body, "old-secret", 1_700_000_000);
    const rotatedAt = new Date(1_700_000_000 * 1000).toISOString();

    const first = verifyWebhookSignatureWithRotation(body, header, {
      currentSecret: "new-secret",
      previousSecret: "old-secret",
      previousSecretRotatedAt: rotatedAt,
      now: 1_700_000_010,
    });
    assert.equal(first, true);

    const replay = verifyWebhookSignatureWithRotation(body, header, {
      currentSecret: "new-secret",
      previousSecret: "old-secret",
      previousSecretRotatedAt: rotatedAt,
      now: 1_700_000_011,
    });
    assert.equal(replay, false);
  });
});

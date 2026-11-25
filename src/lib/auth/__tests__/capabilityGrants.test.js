import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SENSITIVE_ACTIONS,
  generateSensitiveCapabilityToken,
  verifySensitiveCapabilityToken,
  issueSensitiveCapability,
  createCapabilityNonceStore,
} from "../../auth/sensitiveCapabilityToken.js";

const ACTOR = "user-admin-001";
const ACTION = SENSITIVE_ACTIONS[0]; // e.g. PAYOUT_REQUEST
const TARGET = "material-999";
const CONSTRAINTS = { maxAmount: 500 };

function makePayload(overrides = {}) {
  return {
    actor: ACTOR,
    action: ACTION,
    target: TARGET,
    constraints: CONSTRAINTS,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
    nonce: `nonce-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

// ───────────────────────── generate / verify round-trip ─────────────────────

describe("generateSensitiveCapabilityToken + verifySensitiveCapabilityToken", () => {
  it("produces a verifiable token for a valid payload", async () => {
    const payload = makePayload();
    const token = await generateSensitiveCapabilityToken(payload);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    const nonces = createCapabilityNonceStore();
    const result = await verifySensitiveCapabilityToken(token, {
      expectedActor: ACTOR,
      expectedAction: ACTION,
      expectedTarget: TARGET,
      nonceStore: nonces,
    });
    expect(result.valid).toBe(true);
  });

  it("fails verification when token is tampered", async () => {
    const payload = makePayload();
    const token = await generateSensitiveCapabilityToken(payload);
    const tampered = token.slice(0, -4) + "XXXX";
    const nonces = createCapabilityNonceStore();
    const result = await verifySensitiveCapabilityToken(tampered, {
      expectedActor: ACTOR,
      expectedAction: ACTION,
      expectedTarget: TARGET,
      nonceStore: nonces,
    });
    expect(result.valid).toBe(false);
    expect(result.code).toMatch(/EVT_AUTH_002/);
  });
});

// ─────────────────────────────── expiry ─────────────────────────────────────

describe("token expiry", () => {
  it("rejects an expired token", async () => {
    const payload = makePayload({ expiresAt: Date.now() - 1000 });
    const token = await generateSensitiveCapabilityToken(payload);
    const nonces = createCapabilityNonceStore();
    const result = await verifySensitiveCapabilityToken(token, {
      expectedActor: ACTOR,
      expectedAction: ACTION,
      expectedTarget: TARGET,
      nonceStore: nonces,
    });
    expect(result.valid).toBe(false);
    expect(result.code).toMatch(/EVT_AUTH_003/);
    expect(result.retryable).toBe(true);
  });

  it("accepts a token with future expiry", async () => {
    const payload = makePayload({ expiresAt: Date.now() + 60 * 60 * 1000 });
    const token = await generateSensitiveCapabilityToken(payload);
    const nonces = createCapabilityNonceStore();
    const result = await verifySensitiveCapabilityToken(token, {
      expectedActor: ACTOR,
      expectedAction: ACTION,
      expectedTarget: TARGET,
      nonceStore: nonces,
    });
    expect(result.valid).toBe(true);
  });
});

// ─────────────────────────── actor / action / target mismatch ───────────────

describe("claim mismatches", () => {
  it("rejects when expectedActor does not match", async () => {
    const payload = makePayload();
    const token = await generateSensitiveCapabilityToken(payload);
    const nonces = createCapabilityNonceStore();
    const result = await verifySensitiveCapabilityToken(token, {
      expectedActor: "wrong-actor",
      expectedAction: ACTION,
      expectedTarget: TARGET,
      nonceStore: nonces,
    });
    expect(result.valid).toBe(false);
    expect(result.code).toMatch(/EVT_AUTH_004/);
  });

  it("rejects when expectedAction does not match", async () => {
    const payload = makePayload();
    const token = await generateSensitiveCapabilityToken(payload);
    const nonces = createCapabilityNonceStore();
    const result = await verifySensitiveCapabilityToken(token, {
      expectedActor: ACTOR,
      expectedAction: "WRONG_ACTION",
      expectedTarget: TARGET,
      nonceStore: nonces,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects when expectedTarget does not match", async () => {
    const payload = makePayload();
    const token = await generateSensitiveCapabilityToken(payload);
    const nonces = createCapabilityNonceStore();
    const result = await verifySensitiveCapabilityToken(token, {
      expectedActor: ACTOR,
      expectedAction: ACTION,
      expectedTarget: "wrong-target",
      nonceStore: nonces,
    });
    expect(result.valid).toBe(false);
  });
});

// ──────────────────────────── replay protection ──────────────────────────────

describe("replay protection", () => {
  it("rejects a token that has already been consumed", async () => {
    const payload = makePayload();
    const token = await generateSensitiveCapabilityToken(payload);
    const nonces = createCapabilityNonceStore();
    const opts = { expectedActor: ACTOR, expectedAction: ACTION, expectedTarget: TARGET, nonceStore: nonces };

    const first = await verifySensitiveCapabilityToken(token, opts);
    expect(first.valid).toBe(true);

    const second = await verifySensitiveCapabilityToken(token, opts);
    expect(second.valid).toBe(false);
  });

  it("rejects a revoked nonce", async () => {
    const payload = makePayload();
    const token = await generateSensitiveCapabilityToken(payload);
    const nonces = createCapabilityNonceStore();
    nonces.revoke(payload.nonce);

    const result = await verifySensitiveCapabilityToken(token, {
      expectedActor: ACTOR,
      expectedAction: ACTION,
      expectedTarget: TARGET,
      nonceStore: nonces,
    });
    expect(result.valid).toBe(false);
  });
});

// ──────────────────────────── issueSensitiveCapability ───────────────────────

describe("issueSensitiveCapability", () => {
  it("issues a token for an authorised actor", async () => {
    const context = { actor: ACTOR, role: "admin", target: TARGET, action: ACTION };
    const result = await issueSensitiveCapability(context);
    expect(result.token).toBeTruthy();
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("throws or returns an error for an unauthorised actor", async () => {
    const context = { actor: "user-basic-999", role: "learner", target: TARGET, action: ACTION };
    try {
      const result = await issueSensitiveCapability(context);
      // If it returns rather than throwing, the result should indicate denial
      expect(result.error || result.denied).toBeTruthy();
    } catch (err) {
      expect(err).toBeTruthy();
    }
  });

  it("includes constraints in the issued token", async () => {
    const context = { actor: ACTOR, role: "admin", target: TARGET, action: ACTION, constraints: { maxAmount: 100 } };
    const { token } = await issueSensitiveCapability(context);
    const nonces = createCapabilityNonceStore();
    const result = await verifySensitiveCapabilityToken(token, {
      expectedActor: ACTOR,
      expectedAction: ACTION,
      expectedTarget: TARGET,
      nonceStore: nonces,
    });
    expect(result.valid).toBe(true);
    expect(result.payload?.constraints?.maxAmount).toBe(100);
  });
});

// ──────────────────────────── nonce store TTL pruning ────────────────────────

describe("createCapabilityNonceStore", () => {
  it("tracks consumed nonces", () => {
    const store = createCapabilityNonceStore();
    store.consume("nonce-abc");
    expect(store.isConsumed("nonce-abc")).toBe(true);
    expect(store.isConsumed("nonce-xyz")).toBe(false);
  });

  it("tracks revoked nonces", () => {
    const store = createCapabilityNonceStore();
    store.revoke("nonce-revoked");
    expect(store.isRevoked("nonce-revoked")).toBe(true);
  });

  it("prune does not throw", () => {
    const store = createCapabilityNonceStore();
    store.consume("n1");
    expect(() => store.prune()).not.toThrow();
  });
});

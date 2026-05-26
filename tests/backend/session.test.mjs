import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";

import { verifyDashboardToken, isProtectedDashboardPath } from "../../src/lib/auth/session.js";

const secret = "x".repeat(32);

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function signJwt(payload, signingSecret, { exp } = {}) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload };

  if (typeof exp === "number") {
    body.exp = exp;
  } else if (exp !== null) {
    body.exp = now + 3600;
  }

  const headerPart = base64UrlEncode(JSON.stringify(header));
  const payloadPart = base64UrlEncode(JSON.stringify(body));
  const signature = createHmac("sha256", signingSecret)
    .update(`${headerPart}.${payloadPart}`)
    .digest("base64url");

  return `${headerPart}.${payloadPart}.${signature}`;
}

test("isProtectedDashboardPath matches nested dashboard routes", () => {
  assert.equal(isProtectedDashboardPath("/dashboard"), true);
  assert.equal(isProtectedDashboardPath("/dashboard/upload"), true);
  assert.equal(isProtectedDashboardPath("/dashboard/my-materials"), true);
  assert.equal(isProtectedDashboardPath("/marketplace"), false);
});

test("verifyDashboardToken accepts a valid signed token", async () => {
  const token = signJwt(
    { sub: "user-1", email: "user@example.com", walletAddress: "0x0000000000000000000000000000000000000001" },
    secret
  );

  const result = await verifyDashboardToken(token, secret);
  assert.equal(result.valid, true);
  assert.equal(result.payload.sub, "user-1");
});

test("verifyDashboardToken rejects expired tokens", async () => {
  const token = signJwt({ sub: "user-1" }, secret, {
    exp: Math.floor(Date.now() / 1000) - 10,
  });

  const result = await verifyDashboardToken(token, secret);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "expired");
});

test("verifyDashboardToken rejects malformed tokens", async () => {
  const result = await verifyDashboardToken("not-a-jwt", secret);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "malformed");
});

test("verifyDashboardToken rejects forged tokens", async () => {
  const token = signJwt({ sub: "user-1", nonce: randomBytes(8).toString("hex") }, "another-secret");
  const result = await verifyDashboardToken(token, secret);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "forged");
});

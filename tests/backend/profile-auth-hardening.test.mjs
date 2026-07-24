import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { getUserFromCookie } from "../../src/lib/api/auth.js";
import { normalizeWalletAddress as normalizeApiWallet, validateProfilePayload } from "../../src/lib/api/validation.js";
import { normalizeWalletAddress as normalizeAuthWallet } from "../../src/lib/auth/walletAddress.js";

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function createTestJwt(payload, secret, { exp } = {}) {
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
  const signature = createHmac("sha256", secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest("base64url");

  return `${headerPart}.${payloadPart}.${signature}`;
}

function createMockRequest({ headers = {} } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: {
      get(name) {
        return headerMap.get(String(name).toLowerCase()) || null;
      },
    },
  };
}

test("getUserFromCookie returns null when JWT secret environment variables are missing", async () => {
  const oldJwtSecret = process.env.JWT_SECRET;
  const oldNextAuthSecret = process.env.NEXTAUTH_SECRET;
  delete process.env.JWT_SECRET;
  delete process.env.NEXTAUTH_SECRET;

  const req = createMockRequest({
    headers: { cookie: "auth_token=some.jwt.token" },
  });

  const user = await getUserFromCookie(req);
  assert.equal(user, null);

  if (oldJwtSecret !== undefined) process.env.JWT_SECRET = oldJwtSecret;
  if (oldNextAuthSecret !== undefined) process.env.NEXTAUTH_SECRET = oldNextAuthSecret;
});

test("getUserFromCookie handles missing, unencoded, and malformed JWT cookies safely", async () => {
  process.env.JWT_SECRET = "test-secret-123456789012345678901234567890";

  assert.equal(await getUserFromCookie(null), null);
  assert.equal(await getUserFromCookie(createMockRequest()), null);

  const malformedUriReq = createMockRequest({
    headers: { cookie: "auth_token=%E0%A4" },
  });
  assert.equal(await getUserFromCookie(malformedUriReq), null);

  const invalidJwtReq = createMockRequest({
    headers: { cookie: "auth_token=not.a.valid.jwt" },
  });
  assert.equal(await getUserFromCookie(invalidJwtReq), null);

  const forgedJwt = createTestJwt(
    { sub: "user-123", walletAddress: "0x0000000000000000000000000000000000000001" },
    "wrong-signing-secret"
  );
  const forgedReq = createMockRequest({
    headers: { cookie: `dashboard_token=${forgedJwt}` },
  });
  assert.equal(await getUserFromCookie(forgedReq), null);
});

test("getUserFromCookie successfully parses valid auth_token and dashboard_token cookies", async () => {
  const testSecret = "test-secret-123456789012345678901234567890";
  process.env.JWT_SECRET = testSecret;

  const token1 = createTestJwt(
    { sub: "user-1", walletAddress: "0x0000000000000000000000000000000000000001" },
    testSecret
  );
  const req1 = createMockRequest({
    headers: { cookie: `auth_token=${token1}` },
  });
  const user1 = await getUserFromCookie(req1);
  assert.ok(user1);
  assert.equal(user1.sub, "user-1");

  const token2 = createTestJwt(
    { sub: "user-2", walletAddress: "0x0000000000000000000000000000000000000002" },
    testSecret
  );
  const req2 = createMockRequest({
    headers: { cookie: `custom_cookie=foo; dashboard_token=${token2}; bar=baz` },
  });
  const user2 = await getUserFromCookie(req2);
  assert.ok(user2);
  assert.equal(user2.sub, "user-2");
});

test("normalizeWalletAddress normalizes EVM and Stellar wallet addresses consistently", () => {
  const evmUpper = "0x0000000000000000000000000000000000000001";
  assert.equal(normalizeApiWallet(evmUpper), evmUpper.toLowerCase());
  assert.equal(normalizeAuthWallet(evmUpper), evmUpper.toLowerCase());

  const stellarUpper = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  assert.equal(normalizeApiWallet(stellarUpper), stellarUpper.toLowerCase());
  assert.equal(normalizeAuthWallet(stellarUpper), stellarUpper.toLowerCase());

  const stellarLower = "gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaawhf";
  assert.equal(normalizeApiWallet(stellarLower), stellarUpper.toLowerCase());
  assert.equal(normalizeAuthWallet(stellarLower), stellarUpper.toLowerCase());

  assert.throws(() => normalizeApiWallet("invalid-address"), /Invalid wallet address/);
  assert.equal(normalizeAuthWallet("invalid-address"), null);
});

test("validateProfilePayload normalizes walletAddress and walletAddressLower consistently", () => {
  const stellarUpper = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const profile = validateProfilePayload({
    fullName: "EduVault Creator",
    email: "creator@eduvault.io",
    walletAddress: stellarUpper,
  });

  assert.equal(profile.fullName, "EduVault Creator");
  assert.equal(profile.email, "creator@eduvault.io");
  assert.equal(profile.walletAddress, stellarUpper.toLowerCase());
  assert.equal(profile.walletAddressLower, stellarUpper.toLowerCase());
});

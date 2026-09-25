import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";
import { clientKey } from "../../src/lib/api/clientKey.mjs";

function fakeRequest(headers = {}) {
  return { headers: { get: (name) => headers[name.toLowerCase()] || null } };
}

describe("clientKey – spoof resistance", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
    delete process.env.TRUSTED_PROXY_COUNT;
  });

  test("x-forwarded-for is IGNORED even when present", () => {
    const key1 = clientKey(
      fakeRequest({ "x-forwarded-for": "1.2.3.4", "user-agent": "UA1", "accept-language": "en" })
    );
    const key2 = clientKey(
      fakeRequest({ "x-forwarded-for": "10.20.30.40", "user-agent": "UA1", "accept-language": "en" })
    );
    assert.equal(key1, key2, "changing x-forwarded-for must not change the bucket key");
    assert.ok(!key1.startsWith("ip:"), "key must not come from x-forwarded-for");
  });

  test("x-real-ip is ignored without TRUSTED_PROXY_COUNT", () => {
    const key1 = clientKey(
      fakeRequest({ "x-real-ip": "5.5.5.5", "user-agent": "UA1", "accept-language": "en" })
    );
    const key2 = clientKey(
      fakeRequest({ "x-real-ip": "9.9.9.9", "user-agent": "UA1", "accept-language": "en" })
    );
    assert.equal(key1, key2, "changing x-real-ip without proxy flag must not change key");
  });

  test("x-real-ip is trusted when TRUSTED_PROXY_COUNT > 0", () => {
    process.env.TRUSTED_PROXY_COUNT = "1";
    const key1 = clientKey(fakeRequest({ "x-real-ip": "1.1.1.1" }));
    const key2 = clientKey(fakeRequest({ "x-real-ip": "2.2.2.2" }));
    assert.notEqual(key1, key2, "different x-real-ip values should yield different keys when trusted");
    assert.ok(key1.startsWith("proxy:"), "trusted key should use proxy: prefix");
  });

  test("x-vercel-forwarded-for is always trusted (Vercel edge)", () => {
    const key1 = clientKey(
      fakeRequest({ "x-vercel-forwarded-for": "3.3.3.3", "x-forwarded-for": "99.99.99.99" })
    );
    const key2 = clientKey(
      fakeRequest({ "x-vercel-forwarded-for": "4.4.4.4", "x-forwarded-for": "99.99.99.99" })
    );
    assert.notEqual(key1, key2, "different Vercel IPs should produce different keys");
    assert.ok(key1.startsWith("vf:"), "Vercel key should use vf: prefix");
  });

  test("spoofed x-forwarded-for on every request does NOT reset the rate-limit bucket", () => {
    const headers = { "user-agent": "Mozilla/5.0", "accept-language": "en-US" };
    const keys = [];
    for (let i = 0; i < 10; i++) {
      keys.push(
        clientKey(fakeRequest({ ...headers, "x-forwarded-for": `10.0.0.${i}` }))
      );
    }
    const uniqueKeys = new Set(keys);
    assert.equal(uniqueKeys.size, 1, "all 10 requests with different x-forwarded-for must map to the same key");
  });

  test("same UA+accept-language produces stable key across calls", () => {
    const h = { "user-agent": "TestAgent/1.0", "accept-language": "fr" };
    const keys = Array.from({ length: 20 }, () => clientKey(fakeRequest(h)));
    assert.equal(new Set(keys).size, 1, "identical metadata must always produce the same key");
  });

  test("different UA produces different fallback keys", () => {
    const keyA = clientKey(fakeRequest({ "user-agent": "AgentA", "accept-language": "en" }));
    const keyB = clientKey(fakeRequest({ "user-agent": "AgentB", "accept-language": "en" }));
    assert.notEqual(keyA, keyB, "different user-agents must not share a bucket");
  });

  test("absolute fallback (no UA, no accept-language) produces unique keys", () => {
    const key1 = clientKey(fakeRequest({}));
    const key2 = clientKey(fakeRequest({}));
    assert.ok(key1.startsWith("anon:"), "should use anon: prefix");
    assert.notEqual(key1, key2, "completely empty requests should still get unique keys");
  });
});

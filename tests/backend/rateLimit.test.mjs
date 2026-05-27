import assert from "node:assert/strict";
import { test } from "node:test";

import { checkRateLimit, resetRateLimits } from "../../src/lib/api/rateLimit.js";

test("checkRateLimit blocks after the configured request limit", () => {
  resetRateLimits();

  assert.equal(checkRateLimit("profile:local", { limit: 2, now: 1000 }).allowed, true);
  assert.equal(checkRateLimit("profile:local", { limit: 2, now: 1001 }).allowed, true);

  const blocked = checkRateLimit("profile:local", { limit: 2, now: 1002 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 60);
});

test("checkRateLimit allows requests within limit", () => {
  resetRateLimits();

  for (let i = 0; i < 5; i++) {
    const result = checkRateLimit("test:local", { limit: 5, now: 1000 + i });
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 5 - i - 1);
  }
});

test("checkRateLimit resets after window expires", () => {
  resetRateLimits();

  // Exhaust the limit
  checkRateLimit("reset:local", { limit: 2, now: 1000 });
  checkRateLimit("reset:local", { limit: 2, now: 1001 });
  assert.equal(checkRateLimit("reset:local", { limit: 2, now: 1002 }).allowed, false);

  // After window expires
  const resetTime = 1000 + 60_000 + 1;
  const result = checkRateLimit("reset:local", { limit: 2, now: resetTime });
  assert.equal(result.allowed, true);
  assert.equal(result.remaining, 1);
});

test("checkRateLimit uses separate buckets for different keys", () => {
  resetRateLimits();

  // Exhaust limit for key1
  checkRateLimit("key1:local", { limit: 1, now: 1000 });
  assert.equal(checkRateLimit("key1:local", { limit: 1, now: 1001 }).allowed, false);

  // key2 should still work
  assert.equal(checkRateLimit("key2:local", { limit: 1, now: 1001 }).allowed, true);
});

test("checkRateLimit includes retryAfter in blocked response", () => {
  resetRateLimits();

  const now = 5000;
  checkRateLimit("retry:local", { limit: 1, now });
  const blocked = checkRateLimit("retry:local", { limit: 1, now: now + 100 });

  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0);
  assert.ok(blocked.retryAfter <= 60);
});

test("tiered rate limiting - different auth tiers get separate buckets", () => {
  resetRateLimits();

  // Anonymous user bucket
  const anonKey = "profile:GET:127.0.0.1:anonymous";
  // Authenticated user bucket
  const authKey = "profile:GET:127.0.0.1:authenticated";

  // Exhaust anonymous limit
  checkRateLimit(anonKey, { limit: 2, now: 1000 });
  checkRateLimit(anonKey, { limit: 2, now: 1001 });
  assert.equal(checkRateLimit(anonKey, { limit: 2, now: 1002 }).allowed, false);

  // Authenticated bucket should still work
  assert.equal(checkRateLimit(authKey, { limit: 6, now: 1002 }).allowed, true);
});

test("authenticated users get higher effective limits", () => {
  resetRateLimits();

  const baseLimit = 10;
  const multiplier = 3;
  const authLimit = baseLimit * multiplier; // 30

  const authKey = "upload:POST:127.0.0.1:authenticated";

  // Use up to the authenticated limit
  for (let i = 0; i < authLimit; i++) {
    const result = checkRateLimit(authKey, { limit: authLimit, now: 1000 + i });
    assert.equal(result.allowed, true);
  }

  // Next request should be blocked
  const blocked = checkRateLimit(authKey, { limit: authLimit, now: 1000 + authLimit });
  assert.equal(blocked.allowed, false);
});
